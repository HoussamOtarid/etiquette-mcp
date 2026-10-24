import type { NutrientKey } from "../domain/nutrients.ts";
import type { Offer } from "../domain/types.ts";
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
import { KazidomiIndex, parseSitemap } from "./kazidomiIndex.ts";
import { eanOf, priceOf, setNumber } from "./shared.ts";

const API = "https://api.kazidomi.com/api/v2/fr/products";
const SITEMAP = "https://www.kazidomi.com/sitemap-fr-product.xml";
const SITE = "https://www.kazidomi.com";

interface Price {
  priceInclude?: number;
}

interface KazidomiProduct {
  id?: number;
  title?: string;
  nameBo?: string;
  link?: string;
  volume?: number;
  weight?: number;
  eanPrimary?: string | number;
  isAvailable?: boolean;
  energyKJ?: number;
  energyKCAL?: number;
  lipid?: number;
  lipidSugar?: number;
  carbohydrate?: number;
  carbohydrateSuggar?: number;
  fiber?: number;
  proteins?: number;
  salt?: number;
  description?: string;
  allergen?: Array<{ title?: string }>;
  brand?: { data?: { title?: string } };
  prices?: { appliedPrice?: string; prices?: Record<string, Price | undefined> };
}

const FIELDS: Array<[NutrientKey, keyof KazidomiProduct]> = [
  ["energy_kj", "energyKJ"],
  ["energy_kcal", "energyKCAL"],
  ["fat_g", "lipid"],
  ["saturated_fat_g", "lipidSugar"],
  ["carbohydrates_g", "carbohydrate"],
  ["sugars_g", "carbohydrateSuggar"],
  ["fiber_g", "fiber"],
  ["protein_g", "proteins"],
  ["salt_g", "salt"],
];

export function parseKazidomiProduct(p: KazidomiProduct): Offer | null {
  if (!p.id) return null;
  const url = p.link ? `${SITE}${p.link}` : null;
  const label = emptyLabel("kazidomi", url);
  for (const [key, field] of FIELDS) setNumber(label.values, key, p[field]);
  label.basis = (p.volume ?? 0) > 0 ? "100ml" : "100g";
  label.zeroMeansUnknown = true;
  label.ingredients = cleanText(p.description?.replace(/^\s*ingr[ée]dients?\s*:\s*/i, ""));
  label.allergens = cleanText(
    p.allergen
      ?.map((a) => a.title?.trim())
      .filter(Boolean)
      .join(", "),
  );
  label.dataOrigin = "store";
  finalizeLabel(label);

  const brand = cleanText(p.brand?.data?.title);
  const applied = p.prices?.appliedPrice ?? "promo_or_standard";
  const size = (p.volume ?? 0) > 0 ? `${p.volume} ml` : (p.weight ?? 0) > 0 ? `${p.weight} g` : null;
  return {
    source: "kazidomi",
    sourceProductId: String(p.id),
    url,
    name: cleanText(p.title) ?? cleanText(p.nameBo) ?? String(p.id),
    brand,
    ean: eanOf(p.eanPrimary),
    sizeText: size,
    priceEur: priceOf(p.prices?.prices?.[applied]?.priceInclude ?? p.prices?.prices?.standard?.priceInclude),
    inStock: typeof p.isAvailable === "boolean" ? p.isAvailable : null,
    label,
  };
}

/**
 * Kazidomi: online organic shop with a product API (labels included) but no public search endpoint.
 * Name search runs on a local index built from the product sitemap; barcodes are learnt as products are fetched.
 */
export class KazidomiAdapter implements SourceAdapter {
  readonly id = "kazidomi" as const;
  readonly tier = "A" as const;
  readonly displayName = "Kazidomi";
  // Barcodes are only known for products fetched before, so barcode lookups go through name search.
  readonly capabilities = { text: true, ean: false };
  private readonly index: KazidomiIndex;
  private refreshing: Promise<void> | null = null;

  private readonly deps: AdapterDeps;

  constructor(deps: AdapterDeps) {
    this.deps = deps;
    this.index = new KazidomiIndex(deps.cache.database);
  }

  async search(query: SearchQuery): Promise<Offer[]> {
    if (query.ean) {
      const id = this.index.idForEan(query.ean);
      const offer = id ? await this.product(id) : null;
      return offer && offer.ean === query.ean ? [offer] : [];
    }
    if (!query.text) return [];
    await this.ensureIndex();
    const hits = this.index.search(query.text, query.brand, query.limit);
    const offers = await Promise.all(hits.map((h) => this.product(h.id).catch(() => null)));
    return offers.filter((o): o is Offer => o !== null);
  }

  async getLabel(offer: Offer): Promise<LabelResult> {
    if (offer.label) return { label: offer.label };
    const full = await this.product(Number(offer.sourceProductId));
    return { label: full?.label ?? null };
  }

  /** Builds or refreshes the local index; a stale index keeps serving while it refreshes. */
  async ensureIndex(): Promise<void> {
    if (!this.index.isStale()) return;
    this.refreshing ??= (async () => {
      try {
        const res = await this.deps.http.getText(SITEMAP);
        const products = parseSitemap(res.body);
        this.index.replaceAll(products);
        this.deps.logger.info("kazidomi index refreshed", { products: products.length });
      } finally {
        this.refreshing = null;
      }
    })();
    if (this.index.size() === 0) await this.refreshing;
    else
      this.refreshing.catch((e) =>
        this.deps.logger.warn("kazidomi index refresh failed", { error: String(e) }),
      );
  }

  private async product(id: number): Promise<Offer | null> {
    const { value } = await this.deps.cache.wrap<Offer>("label:kazidomi", String(id), TTL.label, async () => {
      const res = await this.deps.http.getJson<KazidomiProduct>(`${API}/${id}`, { allowStatus: [400, 404] });
      if (res.status !== 200) return null;
      return parseKazidomiProduct(res.body);
    });
    if (value?.ean) this.index.rememberEan(value.ean, id);
    return value;
  }
}
