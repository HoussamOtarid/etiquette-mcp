import * as cheerio from "cheerio";
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
import { cachedSearch, eanOf, matchingEan, priceOf } from "./shared.ts";
import { parseTextLabel } from "./textLabel.ts";

const SUGGEST = "https://www.naturalia.fr/search/ajax/suggest/";

interface SuggestItem {
  type?: string;
  title?: string;
  url?: string;
  brand?: string;
  price?: string | number;
  image?: string;
}

export function parseNaturaliaSuggest(items: SuggestItem[]): Offer[] {
  return items.flatMap((item) => {
    if (item.type !== "product" || !item.url || !item.title) return [];
    // Product images are named after the barcode: .../3/7/3700036910362.jpg
    const ean = eanOf(/\/(\d{8,14})\.(?:jpe?g|png|webp)/i.exec(item.image ?? "")?.[1]);
    return [
      {
        source: "naturalia" as const,
        sourceProductId: item.url,
        url: item.url,
        name: item.title,
        brand: cleanText(item.brand),
        ean,
        sizeText: null,
        priceEur: priceOf(item.price),
        unitPriceText: null,
        inStock: null,
      },
    ];
  });
}

/** Naturalia pages put ingredients, the free-text label and traces in one block. */
export function parseNaturaliaProduct(html: string, url: string) {
  const $ = cheerio.load(html);
  const label = emptyLabel("naturalia", url);
  let ean: string | null = null;
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const data = JSON.parse($(el).text()) as Record<string, unknown>;
      if (data["@type"] === "Product") ean = eanOf(data.gtin13 ?? data.gtin);
    } catch {
      // ignore malformed JSON-LD blocks
    }
  }

  const block = cleanText($("#ingredients_info").text()) ?? "";
  const text = block.replace(/^ingr[ée]dients(?:\s+et\s+allerg[eè]nes)?\s*/i, "");
  const labelStart = text.search(
    /valeurs nutritionnelles|informations nutritionnelles|tableau nutritionnel/i,
  );
  const tracesStart = text.search(/peut contenir/i);
  const ingredients =
    labelStart >= 0 ? text.slice(0, labelStart) : tracesStart >= 0 ? text.slice(0, tracesStart) : text;
  label.ingredients = cleanText(ingredients);
  if (labelStart >= 0) {
    const end = tracesStart > labelStart ? tracesStart : text.length;
    const raw = text.slice(labelStart, end);
    const parsed = parseTextLabel(raw);
    label.raw = cleanText(raw);
    label.basis = parsed.basis;
    label.values = parsed.values;
    if (parsed.sodiumG !== undefined) label.sodiumG = parsed.sodiumG;
    label.extra = parsed.extra;
    if (parsed.citesOpenFoodFacts) label.copiedFrom = "off";
  }
  if (tracesStart >= 0) {
    label.traces = cleanText(
      text.slice(tracesStart).replace(/^peut contenir (?:des )?traces? (?:de|d')\s*:?\s*/i, ""),
    );
  }
  label.dataOrigin = "store";
  return { label: finalizeLabel(label), ean };
}

/** Naturalia: organic chain. Search by text or barcode; labels are free text on product pages. */
export class NaturaliaAdapter implements SourceAdapter {
  readonly id = "naturalia" as const;
  readonly tier = "C" as const;
  readonly displayName = "Naturalia";
  readonly capabilities = { text: true, ean: true };

  private readonly deps: AdapterDeps;

  constructor(deps: AdapterDeps) {
    this.deps = deps;
  }

  async search(query: SearchQuery): Promise<Offer[]> {
    const q = query.ean ?? query.text;
    if (!q) return [];
    const offers = await cachedSearch(this.deps, this.id, query, async () => {
      const res = await this.deps.http.getJson<SuggestItem[]>(`${SUGGEST}?${new URLSearchParams({ q })}`, {
        headers: { "x-requested-with": "XMLHttpRequest" },
      });
      const found = parseNaturaliaSuggest(Array.isArray(res.body) ? res.body : []).slice(0, query.limit);
      // A barcode search returns the exact product even when the image name does not carry the barcode.
      return query.ean ? found.map((o) => ({ ...o, ean: o.ean ?? query.ean ?? null })) : found;
    });
    return matchingEan(offers, query.ean);
  }

  async getLabel(offer: Offer): Promise<LabelResult> {
    if (!offer.url) return { label: null };
    const url = offer.url;
    const { value } = await this.deps.cache.wrap<LabelResult>("label:naturalia", url, TTL.label, async () => {
      const res = await this.deps.http.getText(url);
      return parseNaturaliaProduct(res.body, url);
    });
    return value ?? { label: null };
  }
}
