import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextJob } from "../../src/app/offSync.ts";
import { loadConfig } from "../../src/config.ts";
import { Cache } from "../../src/infra/cache.ts";
import { HttpClient } from "../../src/infra/http.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import { categoryText, parseCategoryTaxonomy, TAXONOMY_URL } from "../../src/sources/offCategories.ts";
import {
  applyDeltas,
  DELTA_URL,
  deltaFiles,
  EXPORT_URL,
  fullImport,
  trimOffProduct,
} from "../../src/sources/offImport.ts";
import {
  COPY_FORMAT,
  currentCopyPath,
  META,
  matchExpression,
  newCopyPath,
  type OffLocalReader,
  OffLocalStore,
  openForWrite,
  removeStaleCopies,
  setMeta,
  useCopy,
} from "../../src/sources/offLocal.ts";
import { type OffProduct, OpenFoodFactsAdapter, parseOffProduct } from "../../src/sources/openFoodFacts.ts";

const EAN_A = "3017620422003";
const EAN_B = "5411788047258";
const EAN_C = "4000000000006";

function doc(code: string, name: string, kcal: number, modified: number) {
  return {
    _id: code,
    code,
    product_name: name,
    brands: "Brand",
    quantity: "400 g",
    countries_tags: ["en:france"],
    ingredients_text: "sugar, hazelnuts",
    ingredients_lc: "en",
    last_modified_t: modified,
    nutriments: {},
    nutrition: {
      aggregated_set: {
        per: "100g",
        preparation: "as_sold",
        nutrients: {
          "energy-kcal": {
            value: kcal,
            unit: "kcal",
            source: "packaging",
            source_index: 0,
            value_computed: kcal - 1,
          },
          fat: { value: 30, unit: "g", source: "packaging", source_index: 0 },
          proteins: { value: 6, unit: "g", source: "packaging", source_index: 0 },
          "nova-group": { value: 4, unit: "", source: "packaging" },
        },
      },
      input_sets: [{ source: "packaging", nutrients: {} }],
    },
    images: { front: { sizes: { 400: { w: 400 } } } },
  };
}

const kcalOf = (p: OffProduct | null) => p?.nutrition?.aggregated_set?.nutrients?.["energy-kcal"]?.value;
const fixture = (path: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;

const jsonlGz = (docs: unknown[]) => gzipSync(`${docs.map((d) => JSON.stringify(d)).join("\n")}\n`);

const TAXONOMY = {
  "en:desserts": { name: { en: "Desserts", fr: "Desserts" } },
  "en:sorbets": { name: { en: "Sorbets", fr: "Sorbets" }, parents: ["en:desserts"] },
  "en:lemon-sorbets": { name: { en: "Lemon sorbets", fr: "Sorbets au citron" }, parents: ["en:sorbets"] },
  "en:fruit-juices": { name: { en: "Fruit juices", fr: "Jus de fruits" } },
};

/** A fetch serving fixed bodies by URL (and the category taxonomy); anything else is a 404. */
function stubFetch(files: Record<string, Uint8Array | string>): typeof fetch {
  const served: Record<string, Uint8Array | string> = { [TAXONOMY_URL]: JSON.stringify(TAXONOMY), ...files };
  return (async (input: string | URL | Request) => {
    const body = served[String(input)];
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body);
  }) as typeof fetch;
}

const dir = () => mkdtempSync(join(tmpdir(), "etiquette-off-"));
let clock = 1_800_000_000_000;
const now = () => clock;

async function importWorld(dataDir: string, docs: unknown[], minProducts = 2) {
  return fullImport({
    dataDir,
    userAgent: "test",
    fetch: stubFetch({ [EXPORT_URL]: jsonlGz(docs) }),
    minProducts,
    now,
  });
}

describe("Open Food Facts local copy", () => {
  it("keeps only the fields and nutrients the parser reads", () => {
    expect(trimOffProduct(doc(EAN_A, "Nutella", 539, 100))).toEqual({
      code: EAN_A,
      product_name: "Nutella",
      brands: "Brand",
      quantity: "400 g",
      ingredients_text: "sugar, hazelnuts",
      ingredients_lc: "en",
      last_modified_t: 100,
      countries_tags: ["en:france"],
      nutrition: {
        aggregated_set: {
          per: "100g",
          preparation: "as_sold",
          nutrients: {
            "energy-kcal": { value: 539, unit: "kcal", source: "packaging" },
            fat: { value: 30, unit: "g", source: "packaging" },
            proteins: { value: 6, unit: "g", source: "packaging" },
          },
        },
      },
    });
    expect(trimOffProduct({ _id: EAN_B, product_name: "", nutriments: {} })).toBeNull();
    expect(trimOffProduct({ code: "not-a-barcode", product_name: "X" })).toBeNull();
  });

  it("converts products the export still has in the legacy form to the same label as the API", () => {
    const converted = trimOffProduct(fixture("off/export-legacy-3760109052641.json"));
    expect(converted?.nutrition?.aggregated_set?.nutrients?.carbohydrates).toEqual({ value: 44, unit: "g" });
    const api = (fixture("off/product-3760109052641.json") as { product: OffProduct }).product;
    const values = (p: OffProduct | null | undefined) => {
      const label = parseOffProduct(p ?? {})?.label;
      return { basis: label?.basis, values: label?.values, sodium: label?.sodiumG };
    };
    expect(values(converted)).toEqual(values(api));
    expect(
      trimOffProduct({ code: EAN_B, nutriments: { salt_100g: 0.01, salt_modifier: "<" } }),
    ).toMatchObject({
      nutrition: { aggregated_set: { nutrients: { salt: { value: 0.01, unit: "g", modifier: "<" } } } },
    });
    const drink = trimOffProduct({
      code: EAN_B,
      product_name: "Juice",
      nutrition_data_per: "100ml",
      nutriments: { "energy-kcal_100g": 45 },
    });
    expect(parseOffProduct(drink ?? {})?.label?.basis).toBe("100ml");
    const bottle = trimOffProduct({
      code: EAN_B,
      product_name: "Tamarind",
      serving_quantity_unit: "ml",
      serving_size: "1 BOTTLE (355 ml)",
      nutriments: { "energy-kcal_100g": 54 },
    });
    expect(parseOffProduct(bottle ?? {})?.label?.basis).toBe("100ml");
  });

  it("imports the export into a new copy and answers like the API", async () => {
    const dataDir = dir();
    const result = await importWorld(dataDir, [
      doc(EAN_A, "Nutella", 539, 100),
      doc(EAN_B, "Oat drink", 48, 100),
      "{bad",
    ]);
    expect(result.products).toBe(2);
    const store = new OffLocalStore(dataDir);
    const local = store.get(EAN_A);
    expect(local).not.toBeNull();
    expect(parseOffProduct(local ?? {})?.label?.values.energy_kcal?.value).toBe(539);
    const parsed = (p: Parameters<typeof parseOffProduct>[0]) => {
      const offer = parseOffProduct(p);
      return offer?.label ? { ...offer, label: { ...offer.label, fetchedAt: "" } } : offer;
    };
    expect(parsed(local ?? {})).toEqual(parsed(trimOffProduct(doc(EAN_A, "Nutella", 539, 100)) ?? {}));
    expect(store.status()).toMatchObject({ products: 2, full_import_at: new Date(clock).toISOString() });
    expect(store.get(EAN_C)).toBeNull();
    store.close();
  });

  it("keeps the current copy when a new import looks incomplete", async () => {
    const dataDir = dir();
    await importWorld(dataDir, [doc(EAN_A, "Nutella", 539, 100), doc(EAN_B, "Oat drink", 48, 100)]);
    const before = currentCopyPath(dataDir);
    clock += 1000;
    await expect(importWorld(dataDir, [doc(EAN_A, "Nutella", 539, 100)], 2)).rejects.toThrow(
      /only 1 products/,
    );
    expect(currentCopyPath(dataDir)).toBe(before);
    expect(readdirSync(dataDir).filter((f) => f.endsWith(".db"))).toHaveLength(1);
    await expect(fullImport({ dataDir, userAgent: "t", fetch: stubFetch({}), now })).rejects.toThrow(
      /HTTP 404/,
    );
    const noTaxonomy = stubFetch({
      [EXPORT_URL]: jsonlGz([doc(EAN_A, "Nutella", 539, 100)]),
      [TAXONOMY_URL]: "",
    });
    await expect(
      fullImport({ dataDir, userAgent: "t", fetch: noTaxonomy, minProducts: 1, now }),
    ).rejects.toThrow();
    expect(currentCopyPath(dataDir)).toBe(before);
  });

  it("switches to a rebuilt copy and removes the old one once no longer used", async () => {
    const dataDir = dir();
    await importWorld(dataDir, [doc(EAN_A, "Nutella", 539, 100), doc(EAN_B, "Oat drink", 48, 100)]);
    const store = new OffLocalStore(dataDir);
    const first = currentCopyPath(dataDir);
    clock += 1000;
    await importWorld(dataDir, [doc(EAN_A, "Nutella", 540, 200), doc(EAN_B, "Oat drink", 48, 200)]);
    expect(kcalOf(store.get(EAN_A))).toBe(539);
    store.reopen();
    expect(kcalOf(store.get(EAN_A))).toBe(540);
    expect(removeStaleCopies(dataDir)).toContain(first?.split("/").pop());
    expect(first && existsSync(first)).toBe(false);
    expect(store.get(EAN_B)).not.toBeNull();
    store.close();
  });

  it("applies new daily deltas once, never replacing a product with an older version", async () => {
    const dataDir = dir();
    const started = clock;
    await importWorld(dataDir, [doc(EAN_A, "Nutella", 539, 500), doc(EAN_B, "Oat drink", 48, 500)]);
    const s = Math.floor(started / 1000);
    const old = `openfoodfacts_products_${s - 20 * 86_400}_${s - 19 * 86_400}.json.gz`;
    const d1 = `openfoodfacts_products_${s - 86_400}_${s}.json.gz`;
    const d2 = `openfoodfacts_products_${s}_${s + 86_400}.json.gz`;
    expect(deltaFiles(`${d2}\n${old}\n${d1}\nindex.txt`, s - 3 * 86_400).map((f) => f.name)).toEqual([
      d1,
      d2,
    ]);

    const fetchDeltas = stubFetch({
      [`${DELTA_URL}index.txt`]: `${d2}\n${d1}\n`,
      [`${DELTA_URL}${d1}`]: jsonlGz([
        doc(EAN_A, "Nutella old", 1, 400),
        doc(EAN_C, "New product", 100, 600),
      ]),
      [`${DELTA_URL}${d2}`]: jsonlGz([doc(EAN_B, "Oat drink", 50, 700)]),
    });
    clock += 3_600_000;
    expect(await applyDeltas({ dataDir, userAgent: "t", fetch: fetchDeltas, now })).toEqual({
      files: 2,
      products: 3,
    });
    const store = new OffLocalStore(dataDir);
    expect(store.get(EAN_A)?.product_name).toBe("Nutella");
    expect(kcalOf(store.get(EAN_B))).toBe(50);
    expect(store.get(EAN_C)?.product_name).toBe("New product");
    expect(store.status()).toMatchObject({ products: 3, updated_at: new Date(clock).toISOString() });
    store.close();
    expect(await applyDeltas({ dataDir, userAgent: "t", fetch: fetchDeltas, now })).toEqual({
      files: 0,
      products: 0,
    });
  });

  it("ignores and rebuilds a copy built in another format, without any manual step", async () => {
    const dataDir = dir();
    const path = newCopyPath(dataDir, clock);
    const old = openForWrite(path);
    setMeta(old, { [META.format]: COPY_FORMAT - 1, [META.fullImportAt]: clock, [META.updatedAt]: clock });
    old.close();
    useCopy(dataDir, path);
    const store = new OffLocalStore(dataDir);
    expect(store.status()).toBeNull();
    expect(store.get(EAN_A)).toBeNull();
    expect(nextJob(clock, store.times(), null)).toBe("full");
    await expect(
      applyDeltas({ dataDir, userAgent: "t", fetch: stubFetch({ [`${DELTA_URL}index.txt`]: "" }), now }),
    ).rejects.toThrow(/full import/);
    clock += 1000;
    await importWorld(dataDir, [doc(EAN_A, "Nutella", 539, 100), doc(EAN_B, "Oat drink", 48, 100)]);
    store.reopen();
    expect(kcalOf(store.get(EAN_A))).toBe(539);
    store.close();
  });

  it("searches names and brands, products sold in France first, and follows daily updates", async () => {
    expect(matchExpression("Bonval bœuf haché 5%", undefined)).toBe('"bonval"* "boeuf"* "hache"*');
    expect(matchExpression("macaroni complet", "Priméal")).toBe('"macaroni"* "complet"* brands : "primeal"');
    expect(matchExpression("5%", undefined)).toBeNull();

    const dataDir = dir();
    const abroad = { ...doc(EAN_C, "Pâte à tartiner noisettes", 530, 100), countries_tags: ["en:germany"] };
    const france = {
      ...doc(EAN_A, "Pâte à tartiner noisettes cacao", 539, 100),
      countries_tags: ["en:france"],
    };
    const other = { ...doc(EAN_B, "Boisson avoine", 48, 100), brands: "Lima" };
    await importWorld(dataDir, [abroad, france, other]);
    const store = new OffLocalStore(dataDir);
    expect(store.search("pate tartiner", undefined, 5).map((p) => p.code)).toEqual([EAN_A, EAN_C]);
    expect(store.search("tartiner", "Lima", 5)).toEqual([]);
    expect(store.search("avoine", "Lima", 5).map((p) => p.code)).toEqual([EAN_B]);
    expect(store.search("avoine", "Li", 5)).toEqual([]);
    store.close();

    const s = Math.floor(clock / 1000);
    const delta = `openfoodfacts_products_${s}_${s + 86_400}.json.gz`;
    clock += 3_600_000;
    await applyDeltas({
      dataDir,
      userAgent: "t",
      now,
      fetch: stubFetch({
        [`${DELTA_URL}index.txt`]: delta,
        [`${DELTA_URL}${delta}`]: jsonlGz([
          { ...other, product_name: "Lait d'avoine", last_modified_t: 900 },
        ]),
      }),
    });
    store.reopen();
    expect(store.search("lait avoine", undefined, 5).map((p) => p.code)).toEqual([EAN_B]);
    expect(store.search("boisson", undefined, 5)).toEqual([]);
    store.close();
  });

  it("names products by their most specific categories, in French and English", () => {
    const taxonomy = parseCategoryTaxonomy(TAXONOMY);
    expect(categoryText(["en:desserts", "en:sorbets", "en:lemon-sorbets"], taxonomy)).toBe(
      "sorbets au citron lemon sorbets",
    );
    expect(categoryText(["en:desserts", "fr:sorbet-maison"], taxonomy)).toBe("desserts sorbet maison");
    expect(categoryText(undefined, taxonomy)).toBe("");
  });

  it("finds products by any of their names or by category, name matches first", async () => {
    const dataDir = dir();
    const sorbet = {
      ...doc(EAN_A, "Lemon Sorbet", 120, 100),
      brands: "Häagen-Dazs",
      categories_tags: ["en:desserts", "en:sorbets", "en:lemon-sorbets"],
    };
    const named = { ...doc(EAN_C, "Sorbet citron", 110, 100), categories_tags: ["en:desserts"] };
    const juice = {
      ...doc(EAN_B, "Saft", 45, 100),
      product_name_en: "Apple juice",
      generic_name_fr: "Jus de pomme",
      categories_tags: ["en:fruit-juices"],
    };
    await importWorld(dataDir, [sorbet, named, juice]);
    const store = new OffLocalStore(dataDir);
    expect(store.search("sorbet citron", undefined, 5).map((p) => p.code)).toEqual([EAN_C, EAN_A]);
    expect(store.search("sorbet citron", "Häagen-Dazs", 5).map((p) => p.code)).toEqual([EAN_A]);
    expect(store.search("jus pomme", undefined, 5).map((p) => p.code)).toEqual([EAN_B]);
    expect(store.search("apple juice", undefined, 5).map((p) => p.code)).toEqual([EAN_B]);
    expect(parseOffProduct(store.get(EAN_B) ?? {})?.name).toBe("Saft");
    store.close();
  });

  it("schedules a full import, daily updates and retries", () => {
    const day = 86_400_000;
    const t = 100 * day;
    expect(nextJob(t, { fullImportAt: null, updatedAt: null }, null)).toBe("full");
    expect(nextJob(t, { fullImportAt: t - day, updatedAt: t - 2 * 3_600_000 }, null)).toBeNull();
    expect(nextJob(t, { fullImportAt: t - 5 * day, updatedAt: t - day }, null)).toBe("deltas");
    expect(nextJob(t, { fullImportAt: t - 20 * day, updatedAt: t - 13 * day }, null)).toBe("full");
    expect(nextJob(t, { fullImportAt: t - 31 * day, updatedAt: t - 3_600_000 }, null)).toBe("full");
    expect(nextJob(t, { fullImportAt: null, updatedAt: null }, t - 3_600_000)).toBeNull();
    expect(nextJob(t, { fullImportAt: null, updatedAt: null }, t - 7 * 3_600_000)).toBe("full");
  });
});

describe("Open Food Facts adapter with a local copy", () => {
  afterEach(() => vi.unstubAllGlobals());

  const adapter = (offLocal: OffLocalReader) => {
    const config = loadConfig({ MCP_AUTH_TOKEN: "t".repeat(32) });
    return new OpenFoodFactsAdapter({
      http: new HttpClient({
        userAgent: "t",
        timeoutMs: 1000,
        defaultLimit: { intervalMs: 0, concurrency: 4 },
        logger: silentLogger,
      }),
      cache: new Cache(":memory:"),
      logger: silentLogger,
      config,
      offLocal,
    });
  };

  it("answers barcodes from the local copy, and falls back to the API on a miss or an error", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        status: 1,
        product: { code: EAN_C, product_name: "From API" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const local: OffLocalReader = {
      get: (code) => (code === EAN_A ? trimOffProduct(doc(EAN_A, "Nutella", 539, 100)) : null),
      search: () => [],
      status: () => ({ products: 1, full_import_at: null, updated_at: null }),
    };
    const off = adapter(local);
    expect((await off.search({ ean: EAN_A, limit: 1 }))[0]?.name).toBe("Nutella");
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await off.search({ ean: EAN_C, limit: 1 }))[0]?.name).toBe("From API");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(off.localCopy()).toMatchObject({ products: 1 });

    const broken = adapter({
      get: () => {
        throw new Error("disk error");
      },
      search: () => [],
      status: () => null,
    });
    expect((await broken.search({ ean: EAN_C, limit: 1 }))[0]?.name).toBe("From API");
  });

  it("searches names in the local copy with labels, and online without a copy", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ hits: [{ code: EAN_C, product_name: "Online result", brands: "B" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const local = adapter({
      get: () => null,
      search: (text, brand) =>
        text === "nutella" && !brand ? [trimOffProduct(doc(EAN_A, "Nutella", 539, 100)) ?? {}] : [],
      status: () => ({ products: 1, full_import_at: null, updated_at: null }),
    });
    const [found] = await local.search({ text: "nutella", limit: 5 });
    expect(found).toMatchObject({ name: "Nutella", ean: EAN_A });
    expect(found?.label?.values.energy_kcal?.value).toBe(539);
    expect(fetchMock).not.toHaveBeenCalled();
    const online = adapter({ get: () => null, search: () => [], status: () => null });
    expect((await online.search({ text: "nutella", limit: 5 }))[0]?.name).toBe("Online result");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
