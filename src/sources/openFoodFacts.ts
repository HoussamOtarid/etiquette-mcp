import { usableEan } from "../domain/ean.ts";
import type { NutrientKey } from "../domain/nutrients.ts";
import { brandSlug } from "../domain/text.ts";
import type { Basis, NutrientValue, Offer, SourceLabel } from "../domain/types.ts";
import { TTL } from "../infra/cache.ts";
import { REPOSITORY_URL } from "../version.ts";
import {
  type AdapterDeps,
  cleanText,
  emptyLabel,
  finalizeLabel,
  type LabelResult,
  type SearchQuery,
  type SourceAdapter,
} from "./adapter.ts";
import { LookupQueue } from "./lookupQueue.ts";
import type { LocalCopyStatus } from "./offLocal.ts";
import { cachedSearch } from "./shared.ts";

/** API v3.6, the current version (documented quotas: 15 product reads per minute). */
export const PRODUCT_URL = "https://world.openfoodfacts.org/api/v3.6/product";
const SEARCH_URL = "https://search.openfoodfacts.org/search";
/** Product fields requested from the API, and kept in the local copy. */
export const PRODUCT_FIELDS = [
  "code",
  "product_name",
  "product_name_fr",
  "brands",
  "quantity",
  "nutrition",
  "nutriscore_grade",
  "ingredients_text_fr",
  "ingredients_text",
  "ingredients_lc",
  "allergens_tags",
  "traces_tags",
  "data_sources_tags",
  "last_modified_t",
  "lang",
  "countries_tags",
] as const;
const FIELDS = PRODUCT_FIELDS.join(",");

export interface OffProduct {
  code?: string;
  product_name?: string;
  product_name_fr?: string;
  brands?: string | string[];
  quantity?: string;
  nutriscore_grade?: string;
  ingredients_text_fr?: string;
  ingredients_text?: string;
  /** Language of `ingredients_text`. */
  ingredients_lc?: string;
  allergens_tags?: string[];
  traces_tags?: string[];
  data_sources_tags?: string[];
  last_modified_t?: number;
  lang?: string;
  countries_tags?: string[];
  /** Nutrition facts: one value per nutrient, per `aggregated_set.per`, with its unit, modifier and source. */
  nutrition?: {
    aggregated_set?: {
      per?: string;
      preparation?: string;
      nutrients?: Record<string, { value?: number; unit?: string; modifier?: string; source?: string }>;
    };
  };
}

/** Our nutrients and their ids in Open Food Facts' nutrition facts. */
const NUTRITION: Array<[NutrientKey, string]> = [
  ["energy_kcal", "energy-kcal"],
  ["energy_kj", "energy-kj"],
  ["fat_g", "fat"],
  ["saturated_fat_g", "saturated-fat"],
  ["carbohydrates_g", "carbohydrates"],
  ["sugars_g", "sugars"],
  ["fiber_g", "fiber"],
  ["protein_g", "proteins"],
  ["salt_g", "salt"],
];

/** Every nutrient id the parser reads (energy in kJ and sodium are fallbacks). */
export const NUTRITION_IDS = [...NUTRITION.map(([, id]) => id), "energy", "sodium"];

type OffNutrient = NonNullable<
  NonNullable<NonNullable<OffProduct["nutrition"]>["aggregated_set"]>["nutrients"]
>[string];

/** A nutrient value as printed on the pack, in grams for masses; OFF's own estimates are not label values. */
function labelValue(n: OffNutrient | undefined): NutrientValue | null {
  if (!n || typeof n.value !== "number" || !Number.isFinite(n.value) || n.source === "estimate") return null;
  const value =
    n.unit === "mg" ? n.value / 1000 : n.unit === "µg" || n.unit === "mcg" ? n.value / 1e6 : n.value;
  if (n.modifier === "<" || n.modifier === "≤") return { value, qualifier: "lt" };
  if (n.modifier === ">" || n.modifier === "≥") return { value, qualifier: "gt" };
  return { value };
}

/** Fills the label from the nutrition facts. Values for the prepared product are not the label's as-sold values. */
function readNutrition(product: OffProduct, label: SourceLabel): void {
  const set = product.nutrition?.aggregated_set;
  label.basis = basisFromQuantity(product.quantity, set?.per);
  if (!set?.nutrients || (set.preparation && set.preparation !== "as_sold")) return;
  const nutrients = set.nutrients;
  for (const [key, id] of NUTRITION) {
    const value = labelValue(nutrients[id]);
    if (value) label.values[key] = value;
  }
  const energy = nutrients.energy;
  if (energy?.unit === "kJ" && !label.values.energy_kj) {
    const value = labelValue(energy);
    if (value) label.values.energy_kj = value;
  }
  if (!label.values.salt_g) {
    const sodium = labelValue(nutrients.sodium);
    if (sodium) label.sodiumG = sodium.value;
  }
}

function brandsOf(p: OffProduct): string | null {
  const b = Array.isArray(p.brands) ? p.brands[0] : p.brands?.split(",")[0];
  return cleanText(b);
}

/**
 * Per 100 ml when the data says so or the pack is a volume: "100g" is also Open Food Facts' default when contributors
 * don't say, so for drinks the pack decides.
 */
function basisFromQuantity(quantity: string | undefined, per: string | undefined): Basis {
  if (per === "100ml") return "100ml";
  return quantity && /\d\s*(?:ml|cl|dl|l)\b/i.test(quantity) ? "100ml" : "100g";
}

const tagsText = (tags: string[] | undefined) =>
  tags?.length ? tags.map((t) => t.replace(/^[a-z]{2}:/, "").replace(/-/g, " ")).join(", ") : null;

export function parseOffProduct(product: OffProduct): Offer | null {
  const ean = usableEan(product.code);
  if (!ean) return null;
  const url = `https://world.openfoodfacts.org/product/${ean}`;
  const label = emptyLabel("off", url);
  readNutrition(product, label);
  label.nutriscore = /^[a-e]$/i.test(product.nutriscore_grade ?? "")
    ? (product.nutriscore_grade ?? null)
    : null;
  const ingredientsFr = cleanText(product.ingredients_text_fr);
  label.ingredients = ingredientsFr ?? cleanText(product.ingredients_text);
  const lang = ingredientsFr ? "fr" : (product.ingredients_lc ?? product.lang);
  if (label.ingredients && lang) label.ingredientsLang = lang;
  label.allergens = tagsText(product.allergens_tags);
  label.traces = tagsText(product.traces_tags);
  const sources = product.data_sources_tags ?? [];
  label.dataOrigin = sources.some((s) => s.includes("producer")) ? "producer" : "crowd";
  if (product.last_modified_t) label.updatedAt = new Date(product.last_modified_t * 1000).toISOString();
  finalizeLabel(label);

  return {
    source: "off",
    sourceProductId: ean,
    url,
    name: cleanText(product.product_name_fr ?? product.product_name) ?? ean,
    brand: brandsOf(product),
    ean,
    sizeText: cleanText(product.quantity),
    priceEur: null,
    inStock: null,
    label,
  };
}

export function parseOffSearch(body: { hits?: OffProduct[] }): Offer[] {
  return (body.hits ?? []).flatMap((hit) => {
    const ean = usableEan(hit.code);
    if (!ean) return [];
    return [
      {
        source: "off" as const,
        sourceProductId: ean,
        url: `https://world.openfoodfacts.org/product/${ean}`,
        name: cleanText(hit.product_name) ?? ean,
        brand: brandsOf(hit),
        ean,
        sizeText: cleanText(hit.quantity),
        priceEur: null,
        inStock: null,
      },
    ];
  });
}

/**
 * Open Food Facts: open database, barcode lookup and name/brand search. Never sells anything (no prices).
 * Barcode lookups go through one queue so that concurrent lookups stay within the API quotas.
 */
export class OpenFoodFactsAdapter implements SourceAdapter {
  readonly id = "off" as const;
  readonly tier = "A" as const;
  readonly displayName = "Open Food Facts";
  readonly capabilities = { text: true, ean: true };

  private readonly deps: AdapterDeps;
  private readonly queue: LookupQueue<OffProduct>;
  /** Open Food Facts asks API clients to identify themselves; the public project page is given, nothing personal. */
  private readonly headers: Record<string, string>;

  constructor(deps: AdapterDeps) {
    this.deps = deps;
    this.headers = { "user-agent": `${deps.config.userAgent} (+${REPOSITORY_URL})` };
    this.queue = new LookupQueue((code) => this.fetchProduct(code), {
      maxRetries: 4,
      baseBackoffMs: 5000,
      maxBackoffMs: 60_000,
    });
  }

  async search(query: SearchQuery): Promise<Offer[]> {
    if (query.ean) {
      const offer = await this.byEan(query.ean);
      return offer ? [offer] : [];
    }
    if (!query.text) return [];
    const local = this.searchLocalCopy(query.text, query.brand, query.limit);
    if (local) return local;
    return cachedSearch(this.deps, this.id, query, async () => {
      const q = query.brand ? `${query.text} brands_tags:"${brandSlug(query.brand)}"` : (query.text ?? "");
      const url = `${SEARCH_URL}?${new URLSearchParams({ q, langs: "fr", page_size: String(query.limit), fields: "code,product_name,brands,quantity" })}`;
      const res = await this.deps.http.getJson<{ hits?: OffProduct[] }>(url, { headers: this.headers });
      return parseOffSearch(res.body);
    });
  }

  async getLabel(offer: Offer): Promise<LabelResult> {
    if (offer.label) return { label: offer.label };
    const full = offer.ean ? await this.byEan(offer.ean) : null;
    return { label: full?.label ?? null };
  }

  localCopy(): LocalCopyStatus | null {
    return this.deps.offLocal?.status() ?? null;
  }

  /** Name search in the local copy, with labels; null when there is no copy (or it fails), to use the online search. */
  private searchLocalCopy(text: string, brand: string | undefined, limit: number): Offer[] | null {
    if (!this.deps.offLocal?.status()) return null;
    try {
      return this.deps.offLocal.search(text, brand, limit).flatMap((p) => parseOffProduct(p) ?? []);
    } catch (error) {
      this.deps.logger.warn("off local copy: search failed", { error: String(error) });
      return null;
    }
  }

  /** The local copy answers first; a miss (product added since the last import) or an error falls back to the API. */
  private fromLocalCopy(ean: string): Offer | null {
    if (!this.deps.offLocal) return null;
    try {
      const product = this.deps.offLocal.get(ean);
      return product ? parseOffProduct(product) : null;
    } catch (error) {
      this.deps.logger.warn("off local copy: lookup failed", { error: String(error) });
      return null;
    }
  }

  private async byEan(ean: string): Promise<Offer | null> {
    const local = this.fromLocalCopy(ean);
    if (local) return local;
    const { value } = await this.deps.cache.wrap<Offer>("label:off", ean, TTL.label, async () => {
      const product = await this.queue.lookup(ean);
      return product ? parseOffProduct({ ...product, code: product.code ?? ean }) : null;
    });
    return value;
  }

  private async fetchProduct(ean: string): Promise<OffProduct | null> {
    const res = await this.deps.http.getJson<{ status?: string; product?: OffProduct }>(
      `${PRODUCT_URL}/${ean}?fields=${FIELDS}`,
      { allowStatus: [400, 404], retry: false, headers: this.headers },
    );
    return res.status === 200 && res.body.status !== "failure" ? (res.body.product ?? null) : null;
  }
}
