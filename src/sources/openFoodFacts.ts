import { usableEan } from "../domain/ean.ts";
import type { NutrientKey } from "../domain/nutrients.ts";
import { brandSlug } from "../domain/text.ts";
import type { Basis, Offer } from "../domain/types.ts";
import { TTL } from "../infra/cache.ts";
import {
  type AdapterDeps,
  cleanText,
  emptyLabel,
  finalizeLabel,
  type LabelResult,
  type SearchQuery,
  type SourceAdapter,
} from "./adapter.ts";
import { BarcodeBatcher } from "./barcodeBatcher.ts";
import { cachedSearch, setNumber } from "./shared.ts";

const PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product";
const BATCH_URL = "https://world.openfoodfacts.org/api/v2/search";
const MAX_BATCH = 50;
const SEARCH_URL = "https://search.openfoodfacts.org/search";
const FIELDS = [
  "code",
  "product_name",
  "product_name_fr",
  "brands",
  "quantity",
  "nutriments",
  "nutriscore_grade",
  "ingredients_text_fr",
  "ingredients_text",
  "allergens_tags",
  "traces_tags",
  "data_sources_tags",
  "last_modified_t",
  "lang",
].join(",");

interface OffProduct {
  code?: string;
  product_name?: string;
  product_name_fr?: string;
  brands?: string | string[];
  quantity?: string;
  nutriments?: Record<string, number | string | undefined>;
  nutriscore_grade?: string;
  ingredients_text_fr?: string;
  ingredients_text?: string;
  allergens_tags?: string[];
  traces_tags?: string[];
  data_sources_tags?: string[];
  last_modified_t?: number;
  lang?: string;
}

const NUTRIMENTS: Array<[NutrientKey, string]> = [
  ["energy_kcal", "energy-kcal_100g"],
  ["energy_kj", "energy-kj_100g"],
  ["fat_g", "fat_100g"],
  ["saturated_fat_g", "saturated-fat_100g"],
  ["carbohydrates_g", "carbohydrates_100g"],
  ["sugars_g", "sugars_100g"],
  ["fiber_g", "fiber_100g"],
  ["protein_g", "proteins_100g"],
  ["salt_g", "salt_100g"],
];

function brandsOf(p: OffProduct): string | null {
  const b = Array.isArray(p.brands) ? p.brands[0] : p.brands?.split(",")[0];
  return cleanText(b);
}

/** OFF stores "_100g" values per 100 ml for liquids; the pack quantity tells which applies. */
function basisFromQuantity(quantity: string | undefined): Basis {
  if (!quantity) return "100g";
  return /\d\s*(?:ml|cl|dl|l)\b/i.test(quantity) ? "100ml" : "100g";
}

const tagsText = (tags: string[] | undefined) =>
  tags?.length ? tags.map((t) => t.replace(/^[a-z]{2}:/, "").replace(/-/g, " ")).join(", ") : null;

export function parseOffProduct(product: OffProduct): Offer | null {
  const ean = usableEan(product.code);
  if (!ean) return null;
  const url = `https://world.openfoodfacts.org/product/${ean}`;
  const label = emptyLabel("off", url);
  const n = product.nutriments ?? {};
  for (const [key, field] of NUTRIMENTS) setNumber(label.values, key, n[field]);
  if (label.values.energy_kj === undefined && n.energy_unit === "kJ")
    setNumber(label.values, "energy_kj", n.energy_100g);
  if (label.values.salt_g === undefined && typeof n.sodium_100g === "number") label.sodiumG = n.sodium_100g;
  label.basis = basisFromQuantity(product.quantity);
  label.nutriscore = /^[a-e]$/i.test(product.nutriscore_grade ?? "")
    ? (product.nutriscore_grade ?? null)
    : null;
  const ingredientsFr = cleanText(product.ingredients_text_fr);
  label.ingredients = ingredientsFr ?? cleanText(product.ingredients_text);
  const lang = ingredientsFr ? "fr" : product.lang;
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
    unitPriceText: null,
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
        unitPriceText: null,
        inStock: null,
      },
    ];
  });
}

/**
 * Open Food Facts: open database, barcode lookup and name/brand search. Never sells anything (no prices).
 * Barcode lookups go through a batcher so that concurrent lookups share requests within the API quotas.
 */
export class OpenFoodFactsAdapter implements SourceAdapter {
  readonly id = "off" as const;
  readonly tier = "A" as const;
  readonly displayName = "Open Food Facts";
  readonly capabilities = { text: true, ean: true };

  private readonly deps: AdapterDeps;
  private readonly batcher: BarcodeBatcher<OffProduct>;

  constructor(deps: AdapterDeps) {
    this.deps = deps;
    this.batcher = new BarcodeBatcher<OffProduct>(
      (code) => this.fetchProduct(code),
      (codes) => this.fetchProducts(codes),
      {
        maxBatch: MAX_BATCH,
        maxRetries: 4,
        baseBackoffMs: 5000,
        maxBackoffMs: 60_000,
        manyCooldownMs: 120_000,
      },
    );
  }

  async search(query: SearchQuery): Promise<Offer[]> {
    if (query.ean) {
      const offer = await this.byEan(query.ean);
      return offer ? [offer] : [];
    }
    if (!query.text) return [];
    return cachedSearch(this.deps, this.id, query, async () => {
      const q = query.brand ? `${query.text} brands_tags:"${brandSlug(query.brand)}"` : (query.text ?? "");
      const url = `${SEARCH_URL}?${new URLSearchParams({ q, langs: "fr", page_size: String(query.limit), fields: "code,product_name,brands,quantity" })}`;
      const res = await this.deps.http.getJson<{ hits?: OffProduct[] }>(url);
      return parseOffSearch(res.body);
    });
  }

  async getLabel(offer: Offer): Promise<LabelResult> {
    if (offer.label) return { label: offer.label };
    const full = offer.ean ? await this.byEan(offer.ean) : null;
    return { label: full?.label ?? null };
  }

  private async byEan(ean: string): Promise<Offer | null> {
    const { value } = await this.deps.cache.wrap<Offer>("label:off", ean, TTL.label, async () => {
      const product = await this.batcher.lookup(ean);
      return product ? parseOffProduct({ ...product, code: product.code ?? ean }) : null;
    });
    return value;
  }

  private async fetchProduct(ean: string): Promise<OffProduct | null> {
    const res = await this.deps.http.getJson<{ status?: number; product?: OffProduct }>(
      `${PRODUCT_URL}/${ean}?fields=${FIELDS}`,
      { allowStatus: [404], retry: false },
    );
    return res.status === 404 || res.body.status !== 1 ? null : (res.body.product ?? null);
  }

  private async fetchProducts(eans: string[]): Promise<Map<string, OffProduct>> {
    const params = new URLSearchParams({
      code: eans.join(","),
      fields: FIELDS,
      page_size: String(eans.length),
    });
    const res = await this.deps.http.getJson<{ products?: OffProduct[] }>(`${BATCH_URL}?${params}`, {
      retry: false,
    });
    const byCode = new Map<string, OffProduct>();
    for (const product of res.body.products ?? []) {
      const code = usableEan(product.code);
      if (code) byCode.set(code, product);
    }
    return byCode;
  }
}
