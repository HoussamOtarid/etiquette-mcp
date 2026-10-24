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

const SEARCH = "https://search.deleev.com/multi-go/";
const INDEX = "prod_products_ecommerce";
const SITE = "https://www.labellevie.com";
/** Price and stock zone the search API requires: the shop's own default, used for every request. */
const ZONE = "1-9";

interface Alternate {
  price?: number;
  stock_quantity?: number;
  unlimited_stocks?: boolean;
}

interface Hit {
  id?: string | number;
  selling_name?: string;
  barcode?: string;
  pack_unit_notation?: string;
  alternates?: Record<string, Alternate | undefined>;
}

/** "Yaourts nature, U (4 x 125 g)" → name "Yaourts nature", brand "U", size "4 x 125 g". */
export function splitSellingName(sellingName: string): {
  name: string;
  brand: string | null;
  size: string | null;
} {
  const size = /\(([^)]*\d[^)]*)\)\s*$/.exec(sellingName)?.[1] ?? null;
  const withoutSize = sellingName.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const comma = withoutSize.lastIndexOf(",");
  if (comma < 0) return { name: withoutSize, brand: null, size };
  const brand = withoutSize.slice(comma + 1).trim();
  const looksLikeBrand = brand.length > 0 && brand.length <= 40 && !/\d+\s*%/.test(brand);
  return looksLikeBrand
    ? { name: withoutSize.slice(0, comma).trim(), brand, size }
    : { name: withoutSize, brand: null, size };
}

export function parseLaBelleVieSearch(
  body: { responses?: Array<{ hits?: Hit[] | null }> },
  alternate: string,
): Offer[] {
  const hits = body.responses?.[0]?.hits ?? [];
  return hits.flatMap((hit) => {
    if (hit.id === undefined || !hit.selling_name) return [];
    const { name, brand, size } = splitSellingName(hit.selling_name);
    const alt = hit.alternates?.[alternate];
    const stock = alt ? (alt.unlimited_stocks ? true : (alt.stock_quantity ?? 0) > 0) : null;
    return [
      {
        source: "labellevie" as const,
        sourceProductId: String(hit.id),
        url: `${SITE}/produit/${hit.id}`,
        name,
        brand,
        ean: eanOf(hit.barcode),
        sizeText: size ?? cleanText(hit.pack_unit_notation),
        priceEur: priceOf(alt?.price),
        inStock: stock,
      },
    ];
  });
}

/** La Belle Vie product pages show the supplier's label as free text in a "Valeurs nutritionnelles" box. */
export function parseLaBelleVieProduct(html: string, url: string) {
  const $ = cheerio.load(html);
  const label = emptyLabel("labellevie", url);
  const boxes = new Map<string, string>();
  $("section.box").each((_, el) => {
    const title = cleanText($(el).find(".box-title").first().text());
    const content = cleanText($(el).find(".box-content").first().text());
    if (title && content) boxes.set(title.toLowerCase(), content);
  });

  const raw = boxes.get("valeurs nutritionnelles") ?? null;
  if (raw) {
    const parsed = parseTextLabel(raw);
    label.raw = raw;
    label.basis = parsed.basis;
    label.values = parsed.values;
    if (parsed.sodiumG !== undefined) label.sodiumG = parsed.sodiumG;
    label.extra = parsed.extra;
    if (parsed.citesOpenFoodFacts) label.copiedFrom = "off";
  }
  label.ingredients = boxes.get("ingrédients") ?? null;
  label.allergens = boxes.get("allergènes") ?? null;
  label.dataOrigin = "store";
  return { label: finalizeLabel(label) };
}

/**
 * La Belle Vie: Paris-area online grocery. Search (text or barcode) returns barcodes, prices and stock for the
 * configured delivery zone; labels are free text on product pages.
 */
export class LaBelleVieAdapter implements SourceAdapter {
  readonly id = "labellevie" as const;
  readonly tier = "C" as const;
  readonly displayName = "La Belle Vie";
  readonly capabilities = { text: true, ean: true };

  private readonly deps: AdapterDeps;

  constructor(deps: AdapterDeps) {
    this.deps = deps;
  }

  async search(query: SearchQuery): Promise<Offer[]> {
    const q = query.ean ?? query.text;
    if (!q) return [];
    const offers = await cachedSearch(this.deps, this.id, query, async () => {
      // Anonymous search: the shop's own default zone, never a user id.
      const res = await this.deps.http.postJson<{ responses?: Array<{ hits?: Hit[] | null }> }>(SEARCH, {
        requests: [{ indexName: INDEX, q, alternate: ZONE, perPage: Math.max(query.limit, 3), page: 1 }],
      });
      return parseLaBelleVieSearch(res.body, ZONE).slice(0, query.limit);
    });
    return matchingEan(offers, query.ean);
  }

  async getLabel(offer: Offer): Promise<LabelResult> {
    if (!offer.url) return { label: null };
    const url = offer.url;
    const { value } = await this.deps.cache.wrap<LabelResult>(
      "label:labellevie",
      url,
      TTL.label,
      async () => {
        const res = await this.deps.http.getText(url);
        return parseLaBelleVieProduct(res.body, url);
      },
    );
    return value ?? { label: null };
  }
}
