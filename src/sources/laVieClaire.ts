import * as cheerio from "cheerio";
import type { NutrientKey } from "../domain/nutrients.ts";
import { brandSlug, tokenSimilarity } from "../domain/text.ts";
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
import { cachedSearch, eanOf, priceOf, setNumber } from "./shared.ts";

const STORE_API = "https://www.lavieclaire.com/wp-json/wc/store/v1/products";
const BRAND_PAGE_SIZE = 100;

interface StoreProduct {
  id?: number;
  name?: string;
  permalink?: string;
  is_in_stock?: boolean;
  brands?: Array<{ name?: string }>;
  prices?: { price?: string; currency_minor_unit?: number };
}

const ROWS: Array<[RegExp, NutrientKey]> = [
  [/kj/i, "energy_kj"],
  [/kcal/i, "energy_kcal"],
  [/satur/i, "saturated_fat_g"],
  [/mati[eè]res grasses|lipides/i, "fat_g"],
  [/sucres/i, "sugars_g"],
  [/glucides/i, "carbohydrates_g"],
  [/fibres/i, "fiber_g"],
  [/prot[ée]ines/i, "protein_g"],
  [/\bsel\b/i, "salt_g"],
];

const decodeEntities = (s: string) => cheerio.load(`<p>${s}</p>`)("p").text();

export function parseLaVieClaireSearch(products: StoreProduct[]): Offer[] {
  return products.flatMap((p) => {
    if (!p.permalink || !p.name) return [];
    const minor = p.prices?.currency_minor_unit ?? 2;
    const price = p.prices?.price ? Number(p.prices.price) / 10 ** minor : null;
    return [
      {
        source: "lavieclaire" as const,
        sourceProductId: p.permalink,
        url: p.permalink,
        name: decodeEntities(p.name),
        brand: cleanText(p.brands?.[0]?.name),
        ean: null,
        sizeText: null,
        priceEur: priceOf(price),
        unitPriceText: null,
        inStock: typeof p.is_in_stock === "boolean" ? p.is_in_stock : null,
      },
    ];
  });
}

function jsonLdGtin($: cheerio.CheerioAPI): string | null {
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(el).text()) as Record<string, unknown> | Array<Record<string, unknown>>;
      const nodes = Array.isArray(data)
        ? data
        : ((data["@graph"] as Array<Record<string, unknown>>) ?? [data]);
      for (const node of nodes) {
        if (node["@type"] === "Product") return eanOf(node.gtin13 ?? node.gtin ?? node.gtin8);
      }
    } catch {
      // ignore malformed JSON-LD blocks
    }
  }
  return null;
}

/** La Vie Claire product pages carry a nutrition table and the barcode in JSON-LD. */
export function parseLaVieClaireProduct(html: string, url: string) {
  const $ = cheerio.load(html);
  const label = emptyLabel("lavieclaire", url);
  const table = $("table.product-content-accordion__nutrition").first();
  const caption = cleanText(table.find("caption").text()) ?? "";
  const firstHeader = cleanText(table.find("th").first().text()) ?? "";
  label.basis = /ml/i.test(caption) || /^ml\b/i.test(firstHeader) ? "100ml" : "100g";

  const rawLines: string[] = [];
  table.find("tr").each((_, tr) => {
    const name = (cleanText($(tr).find("th").text()) ?? "").replace(/^(?:g|ml)\.\s*/i, "");
    const value = cleanText($(tr).find("td").text()) ?? "";
    if (!name) return;
    rawLines.push(`${name}: ${value}`);
    const key = ROWS.find(([re]) => re.test(name))?.[1];
    if (key && label.values[key] === undefined) setNumber(label.values, key, value);
    else if (!key)
      label.extra.push({
        name,
        value: Number.parseFloat(value) || null,
        unit: null,
        raw: `${name}: ${value}`,
      });
  });
  label.raw = rawLines.length ? `${caption}: ${rawLines.join("; ")}` : null;

  $("p.product-content-accordion__text").each((_, p) => {
    const text = cleanText($(p).text()) ?? "";
    const ingredients = /^ingr[ée]dients\s*:\s*(.+)$/i.exec(text)?.[1];
    if (ingredients && !label.ingredients) label.ingredients = ingredients;
    const allergens = /^allerg[eè]nes\s*:\s*(.+)$/i.exec(text)?.[1];
    if (allergens && !label.allergens) label.allergens = allergens;
  });
  label.dataOrigin = "store";
  return { label: finalizeLabel(label), ean: jsonLdGtin($) };
}

/** La Vie Claire: organic chain with its own brand. Search via the shop API; labels and barcode on the page. */
export class LaVieClaireAdapter implements SourceAdapter {
  readonly id = "lavieclaire" as const;
  readonly tier = "B" as const;
  readonly displayName = "La Vie Claire";
  readonly capabilities = { text: true, ean: false };

  private readonly deps: AdapterDeps;

  constructor(deps: AdapterDeps) {
    this.deps = deps;
  }

  /**
   * The shop search matches contiguous phrases only, so when a brand is known the brand's range is listed instead
   * and ranked locally by name similarity.
   */
  async search(query: SearchQuery): Promise<Offer[]> {
    if (!query.text) return [];
    const text = query.text;
    return cachedSearch(this.deps, this.id, query, async () => {
      if (query.brand) {
        const range = await this.list({ brand: brandSlug(query.brand), per_page: String(BRAND_PAGE_SIZE) });
        if (range.length > 0) {
          return range
            .map((o) => ({ o, score: tokenSimilarity(text, o.name) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, query.limit)
            .map((x) => x.o);
        }
      }
      return this.list({ search: text, per_page: String(query.limit) });
    });
  }

  private async list(params: Record<string, string>): Promise<Offer[]> {
    const res = await this.deps.http.getJson<StoreProduct[]>(`${STORE_API}?${new URLSearchParams(params)}`);
    return parseLaVieClaireSearch(Array.isArray(res.body) ? res.body : []);
  }

  async getLabel(offer: Offer): Promise<LabelResult> {
    if (!offer.url) return { label: null };
    const url = offer.url;
    const { value } = await this.deps.cache.wrap<LabelResult>(
      "label:lavieclaire",
      url,
      TTL.label,
      async () => {
        const res = await this.deps.http.getText(url);
        return parseLaVieClaireProduct(res.body, url);
      },
    );
    return value ?? { label: null };
  }
}
