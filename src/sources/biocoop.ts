import * as cheerio from "cheerio";
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
import { cachedSearch, eanOf, firstString, matchingEan, priceOf, setNumber } from "./shared.ts";

const SUGGEST = "https://www.biocoop.fr/search/ajax/suggest/";

interface SuggestItem {
  type?: string;
  name?: string[] | string;
  ean?: string[] | string;
  option_text_brand?: string[] | string;
  sku?: string;
  mesure?: string;
  price?: number | string;
  url?: string;
  stock?: { is_in_stock?: boolean };
}

const LABELS: Array<[RegExp, NutrientKey]> = [
  [/^valeur [ée]nerg[ée]tique.*kj/i, "energy_kj"],
  [/^calories|kcal/i, "energy_kcal"],
  [/satur/i, "saturated_fat_g"],
  [/^mati[eè]res grasses/i, "fat_g"],
  [/sucres/i, "sugars_g"],
  [/^glucides/i, "carbohydrates_g"],
  [/fibres/i, "fiber_g"],
  [/^prot[ée]ines/i, "protein_g"],
  [/^sel\b/i, "salt_g"],
];

export function parseBiocoopSuggest(items: SuggestItem[]): Offer[] {
  return items.flatMap((item) => {
    if (item.type !== "product" || !item.url) return [];
    const name = firstString(item.name);
    if (!name) return [];
    return [
      {
        source: "biocoop" as const,
        sourceProductId: item.url,
        url: item.url,
        name,
        brand: firstString(item.option_text_brand),
        ean: eanOf(item.ean),
        sizeText: cleanText(item.mesure?.replace(/&nbsp;/g, " ")),
        priceEur: priceOf(item.price),
        unitPriceText: null,
        inStock: typeof item.stock?.is_in_stock === "boolean" ? item.stock.is_in_stock : null,
      },
    ];
  });
}

/** Biocoop product pages list the label as label/value pairs generated from product data. */
export function parseBiocoopProduct(html: string, url: string) {
  const $ = cheerio.load(html);
  const label = emptyLabel("biocoop", url);
  const section = $("#nutrional-values-product");
  const title = cleanText(section.find(".tab-content--title").first().text()) ?? "";
  label.basis = /100\s*g\s*\/\s*100\s*ml/i.test(title)
    ? "100g/100ml"
    : /100\s*ml/i.test(title)
      ? "100ml"
      : "100g";

  const rawLines: string[] = [];
  section.find(".product-attribute").each((_, li) => {
    const labels = $(li).find(".product-attribute--label");
    const values = $(li).find(".product-attribute--value");
    labels.each((i, el) => {
      const name = cleanText($(el).text()) ?? "";
      const value = cleanText(values.eq(i).text()) ?? "";
      if (!name) return;
      rawLines.push(`${name}: ${value}`);
      const bare = name.replace(/^dont\s+/i, "").replace(/\s*\(.*\)\s*$/, "");
      const key = LABELS.find(([re]) => re.test(bare) || re.test(name))?.[1];
      if (key && label.values[key] === undefined) setNumber(label.values, key, value);
      else if (!key)
        label.extra.push({
          name: bare,
          value: Number.parseFloat(value) || null,
          unit: null,
          raw: `${name}: ${value}`,
        });
    });
  });
  label.raw = rawLines.length ? rawLines.join("; ") : null;

  const composition = $("#composition-product");
  label.ingredients = cleanText(composition.find(".product-info--description").first().text());
  composition.find(".product-attribute").each((_, li) => {
    const text = cleanText($(li).text()) ?? "";
    const allergens = /^allerg[eè]nes\s*:\s*(.+)$/i.exec(text)?.[1];
    const traces = /^traces de\s*:\s*(.+)$/i.exec(text)?.[1];
    if (allergens && !/^n[ée]ant$/i.test(allergens)) label.allergens = cleanText(allergens);
    if (traces && !/^n[ée]ant$/i.test(traces)) label.traces = cleanText(traces);
  });
  label.dataOrigin = "store";
  const ean = eanOf(/"(?:gtin13|ean)"\s*:\s*"?(\d{8,14})/.exec(html)?.[1]);
  return { label: finalizeLabel(label), ean };
}

/** Biocoop: France's largest organic retail network. Search returns barcodes; labels come from product pages. */
export class BiocoopAdapter implements SourceAdapter {
  readonly id = "biocoop" as const;
  readonly tier = "B" as const;
  readonly displayName = "Biocoop";
  readonly capabilities = { text: true, ean: true };

  constructor(private readonly deps: AdapterDeps) {}

  async search(query: SearchQuery): Promise<Offer[]> {
    const q = query.ean ?? query.text;
    if (!q) return [];
    const offers = await cachedSearch(this.deps, this.id, query, async () => {
      const res = await this.deps.http.getJson<SuggestItem[]>(`${SUGGEST}?${new URLSearchParams({ q })}`, {
        headers: { "x-requested-with": "XMLHttpRequest" },
      });
      return parseBiocoopSuggest(Array.isArray(res.body) ? res.body : []).slice(0, query.limit);
    });
    return matchingEan(offers, query.ean);
  }

  async getLabel(offer: Offer): Promise<LabelResult> {
    if (!offer.url) return { label: null };
    const url = offer.url;
    const { value } = await this.deps.cache.wrap<LabelResult>("label:biocoop", url, TTL.label, async () => {
      const res = await this.deps.http.getText(url);
      return parseBiocoopProduct(res.body, url);
    });
    return value ?? { label: null };
  }
}
