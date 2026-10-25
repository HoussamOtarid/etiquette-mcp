import { rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { usableEan } from "../domain/ean.ts";
import { type CategoryTaxonomy, parseCategoryTaxonomy, TAXONOMY_URL } from "./offCategories.ts";
import {
  COPY_FORMAT,
  countProducts,
  currentCopyPath,
  getMeta,
  META,
  newCopyPath,
  openForWrite,
  setMeta,
  upsertProducts,
  useCopy,
} from "./offLocal.ts";
import { NUTRITION_IDS, type OffProduct, PRODUCT_FIELDS } from "./openFoodFacts.ts";

export const EXPORT_URL = "https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz";
export const DELTA_URL = "https://static.openfoodfacts.org/data/delta/";
/** A complete world export has several million products; far fewer means a truncated download. */
export const MIN_PRODUCTS = 1_000_000;
const BATCH = 5000;
const PROGRESS_EVERY = 250_000;
/** Products changed shortly before the export was generated are only in the deltas: replay the last days. */
const REPLAY_S = 3 * 86_400;
const DELTA_FILE = /^openfoodfacts_products_(\d+)_(\d+)\.json\.gz$/;

export interface ImportOptions {
  dataDir: string;
  userAgent: string;
  fetch?: typeof fetch;
  minProducts?: number;
  now?: () => number;
  onProgress?: (products: number) => void;
}

type Nutrients = NonNullable<
  NonNullable<NonNullable<OffProduct["nutrition"]>["aggregated_set"]>["nutrients"]
>;

const isEmpty = (v: unknown) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** The unit Open Food Facts' legacy per-100 values are expressed in. */
const legacyUnit = (id: string) =>
  id === "energy-kcal" ? "kcal" : id === "energy-kj" || id === "energy" ? "kJ" : "g";

/**
 * Nutrition facts of a product the export still carries in the legacy `nutriments` form (entries OFF hasn't migrated),
 * in the current structure: per-100 values, their units and "<"/">"/"~" modifiers. No source is recorded there, so
 * the values count as label values, as the API presents them.
 */
function nutrientsFromLegacy(legacy: Record<string, unknown>): Nutrients {
  const nutrients: Nutrients = {};
  for (const id of NUTRITION_IDS) {
    const value = legacy[`${id}_100g`];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const modifier = legacy[`${id}_modifier`];
    nutrients[id] = {
      value,
      unit: legacyUnit(id),
      ...(typeof modifier === "string" && modifier ? { modifier } : {}),
    };
  }
  return nutrients;
}

/**
 * Reduces an exported product to what the API returns for `PRODUCT_FIELDS`, keeping only the nutrients the parser
 * reads. Products with neither a name nor nutrition facts are of no use and give null.
 */
export function trimOffProduct(doc: Record<string, unknown>): OffProduct | null {
  const code = usableEan(String(doc.code ?? doc._id ?? ""));
  if (!code) return null;
  const out: Record<string, unknown> = { code };
  for (const field of PRODUCT_FIELDS) {
    if (field !== "code" && field !== "nutrition" && !isEmpty(doc[field])) out[field] = doc[field];
  }
  const set = (doc.nutrition as OffProduct["nutrition"])?.aggregated_set;
  const nutrients: Nutrients = {};
  for (const id of NUTRITION_IDS) {
    const n = set?.nutrients?.[id];
    if (!n || isEmpty(n.value)) continue;
    nutrients[id] = {
      value: n.value,
      ...(n.unit ? { unit: n.unit } : {}),
      ...(n.modifier ? { modifier: n.modifier } : {}),
      ...(n.source ? { source: n.source } : {}),
    };
  }
  if (Object.keys(nutrients).length > 0) {
    out.nutrition = { aggregated_set: { per: set?.per, preparation: set?.preparation, nutrients } };
  } else {
    const legacy = nutrientsFromLegacy((doc.nutriments ?? {}) as Record<string, unknown>);
    // Legacy per-100 values are per 100 ml for products measured in ml, as Open Food Facts reads them.
    const per = doc.nutrition_data_per === "100ml" || doc.serving_quantity_unit === "ml" ? "100ml" : "100g";
    if (Object.keys(legacy).length > 0)
      out.nutrition = { aggregated_set: { per, preparation: "as_sold", nutrients: legacy } };
  }
  if (!out.product_name && !out.product_name_fr && !out.nutrition) return null;
  return out as OffProduct;
}

async function* productsFrom(url: string, opts: ImportOptions): AsyncGenerator<OffProduct> {
  const res = await (opts.fetch ?? fetch)(url, { headers: { "user-agent": opts.userAgent } });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const input = Readable.fromWeb(res.body as ReadableStream).pipe(createGunzip());
  for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (!line) continue;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const product = trimOffProduct(doc);
    if (product) yield product;
  }
}

/** The category taxonomy, fetched for each import so new categories get their names in the index. */
async function fetchTaxonomy(opts: ImportOptions): Promise<CategoryTaxonomy> {
  const res = await (opts.fetch ?? fetch)(TAXONOMY_URL, { headers: { "user-agent": opts.userAgent } });
  if (!res.ok) throw new Error(`category taxonomy: HTTP ${res.status}`);
  return parseCategoryTaxonomy((await res.json()) as Parameters<typeof parseCategoryTaxonomy>[0]);
}

async function load(
  db: ReturnType<typeof openForWrite>,
  products: AsyncIterable<OffProduct>,
  taxonomy: CategoryTaxonomy,
  onProgress?: (n: number) => void,
): Promise<number> {
  let batch: OffProduct[] = [];
  let loaded = 0;
  for await (const product of products) {
    batch.push(product);
    if (batch.length < BATCH) continue;
    upsertProducts(db, batch, taxonomy);
    loaded += batch.length;
    batch = [];
    if (onProgress && loaded % PROGRESS_EVERY === 0) onProgress(loaded);
  }
  if (batch.length > 0) upsertProducts(db, batch, taxonomy);
  return loaded + batch.length;
}

/** Builds a new copy from the full export and switches to it once it looks complete. */
export async function fullImport(opts: ImportOptions): Promise<{ products: number; path: string }> {
  const now = opts.now ?? Date.now;
  const started = now();
  const path = newCopyPath(opts.dataDir, started);
  const db = openForWrite(path, { bulk: true });
  try {
    await load(db, productsFrom(EXPORT_URL, opts), await fetchTaxonomy(opts), opts.onProgress);
    const products = countProducts(db);
    const min = opts.minProducts ?? MIN_PRODUCTS;
    if (products < min) throw new Error(`only ${products} products imported (expected at least ${min})`);
    setMeta(db, {
      [META.format]: COPY_FORMAT,
      [META.fullImportAt]: now(),
      [META.updatedAt]: now(),
      [META.products]: products,
      [META.lastDeltaEnd]: Math.floor(started / 1000) - REPLAY_S,
    });
    db.exec("PRAGMA journal_mode = WAL;");
    db.close();
    useCopy(opts.dataDir, path);
    return { products, path };
  } catch (error) {
    if (db.isOpen) db.close();
    rmSync(path, { force: true });
    throw error;
  }
}

/** Delta files ending after `lastEnd` (unix seconds), oldest first. */
export function deltaFiles(index: string, lastEnd: number): Array<{ name: string; end: number }> {
  return index
    .split(/\s+/)
    .flatMap((name) => {
      const m = DELTA_FILE.exec(name);
      return m ? [{ name, start: Number(m[1]), end: Number(m[2]) }] : [];
    })
    .filter((f) => f.end > lastEnd)
    .sort((a, b) => a.start - b.start)
    .map(({ name, end }) => ({ name, end }));
}

/** Applies the daily deltas not applied yet to the current copy. */
export async function applyDeltas(opts: ImportOptions): Promise<{ files: number; products: number }> {
  const now = opts.now ?? Date.now;
  const path = currentCopyPath(opts.dataDir);
  if (!path) throw new Error("no local copy to update");
  const res = await (opts.fetch ?? fetch)(`${DELTA_URL}index.txt`, {
    headers: { "user-agent": opts.userAgent },
  });
  if (!res.ok) throw new Error(`delta index: HTTP ${res.status}`);
  const index = await res.text();
  const db = openForWrite(path);
  try {
    if (getMeta(db, META.format) !== String(COPY_FORMAT))
      throw new Error("the local copy was built by another version; run a full import");
    const files = deltaFiles(index, Number(getMeta(db, META.lastDeltaEnd) ?? 0));
    const taxonomy = files.length > 0 ? await fetchTaxonomy(opts) : new Map();
    let products = 0;
    for (const file of files) {
      products += await load(db, productsFrom(`${DELTA_URL}${file.name}`, opts), taxonomy);
      setMeta(db, { [META.lastDeltaEnd]: file.end });
    }
    setMeta(db, { [META.updatedAt]: now(), [META.products]: countProducts(db) });
    return { files: files.length, products };
  } finally {
    db.close();
  }
}
