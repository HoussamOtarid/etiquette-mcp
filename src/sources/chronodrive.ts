import * as cheerio from "cheerio";
import { unflatten } from "devalue";
import { usableEan } from "../domain/ean.ts";
import { parseNumber } from "../domain/numbers.ts";
import type { NutrientKey } from "../domain/nutrients.ts";
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
import { cachedSearch, matchingEan, priceOf, setNumber } from "./shared.ts";

const SITE = "https://www.chronodrive.com";
/**
 * Product pages are sometimes rendered without their details (about one request in five, sometimes several in a
 * row); a later request usually gets the full page.
 */
const PAGE_ATTEMPTS = 4;
const RETRY_PAUSE_MS = 3000;
const HTML = { accept: "text/html,application/xhtml+xml" };

interface ListedProduct {
  id?: string;
  eans?: string[];
  labels?: { productLabel?: string; brandLabel?: string; unitQuantityLabel?: string };
  prices?: { defaultPrice?: number };
  stock?: string;
}

/** Nuxt wraps some payload values in its own types; their content is plain data. */
const NUXT_TYPES = [
  "ShallowReactive",
  "Reactive",
  "Ref",
  "ShallowRef",
  "EmptyRef",
  "EmptyShallowRef",
  "NuxtError",
];
const REVIVERS = Object.fromEntries(NUXT_TYPES.map((type) => [type, (value: unknown) => value]));

const LABELS: Array<[RegExp, NutrientKey]> = [
  [/satur/i, "saturated_fat_g"],
  [/^mati[eè]res grasses/i, "fat_g"],
  [/sucres/i, "sugars_g"],
  [/^glucides/i, "carbohydrates_g"],
  [/fibres/i, "fiber_g"],
  [/^prot[ée]ines/i, "protein_g"],
  [/^sel\b/i, "salt_g"],
];

/** All barcodes of a listed product; some entries hold several, separated by spaces. */
function barcodesOf(product: ListedProduct): string[] {
  const codes = (product.eans ?? []).flatMap((e) => e.split(/\s+/)).map((e) => usableEan(e));
  return [...new Set(codes.filter((e): e is string => e !== null))];
}

/** Search results live in the page's Nuxt payload; product links are in the rendered cards. */
export function parseChronodriveSearch(html: string, wantedEan?: string): Offer[] {
  const raw = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!raw) throw new Error("chronodrive: search payload not found");
  const payload = unflatten(JSON.parse(raw), REVIVERS) as { data?: Record<string, unknown> };
  const listingKey = Object.keys(payload.data ?? {}).find((k) => k.startsWith("catalog-listing-"));
  const listing = listingKey
    ? (payload.data?.[listingKey] as Array<{ value?: { content?: ListedProduct[] } }>)
    : [];
  const links = new Map<string, string>();
  for (const [, path, id] of html.matchAll(/href="(\/[^"]*-P([\w]+))"/g)) if (path && id) links.set(id, path);

  const seen = new Set<string>();
  return (listing[0]?.value?.content ?? []).flatMap((product) => {
    const name = cleanText(product.labels?.productLabel);
    if (!product.id || !name || seen.has(product.id)) return [];
    seen.add(product.id);
    const barcodes = barcodesOf(product);
    const ean = wantedEan && barcodes.includes(wantedEan) ? wantedEan : (barcodes[0] ?? null);
    return [
      {
        source: "chronodrive" as const,
        sourceProductId: product.id,
        url: `${SITE}${links.get(product.id) ?? `/produit-P${product.id}`}`,
        name,
        brand: cleanText(product.labels?.brandLabel),
        ean,
        sizeText: cleanText(product.labels?.unitQuantityLabel),
        priceEur: priceOf(product.prices?.defaultPrice),
        inStock: product.stock ? !/out|no_stock|unavailable/i.test(product.stock) : null,
      },
    ];
  });
}

/** The full product page carries a JSON-LD Product; the incomplete rendering has neither it nor the label. */
export function hasProductDetails(html: string): boolean {
  return /"@type"\s*:\s*"Product"/.test(html);
}

/** Headings read "pour 100 g", "pour 100 g|ml" or "pour 100.000 gr". */
function basisOf(text: string): Basis {
  const heading = text.replace(/100[.,]0+/g, "100");
  if (/100\s*g\s*(\||\/)\s*(100\s*)?ml/i.test(heading)) return "100g/100ml";
  if (/100\s*ml/i.test(heading)) return "100ml";
  if (/100\s*g/i.test(heading)) return "100g";
  return "unknown";
}

/** Product page: a nutrition table (label rows followed by value rows), ingredients, allergens and JSON-LD. */
export function parseChronodriveProduct(html: string, url: string) {
  const $ = cheerio.load(html);
  const label = emptyLabel("chronodrive", url);
  const section = $("#edito-section-ingredients");
  const table = section
    .find("table")
    .filter((_, t) => /valeurs nutritionnelles/i.test($(t).find("thead").text()))
    .first();
  label.basis = basisOf(cleanText(table.find("thead th").first().text()) ?? "");

  const rawLines: string[] = [];
  let name: string | null = null;
  table.find("tbody tr").each((_, tr) => {
    const cell = $(tr).find("td").first();
    if (cell.hasClass("-label")) {
      name = cleanText(cell.text());
      return;
    }
    const value = cleanText(cell.text());
    if (!name || !value) return;
    rawLines.push(`${name}: ${value}`);
    const bare = name.replace(/\s+dont$/i, "");
    if (/^[ée]nergie|valeur [ée]nerg[ée]tique/i.test(bare)) {
      setNumber(label.values, "energy_kj", /([\d.,]+)\s*kj/i.exec(value)?.[1]);
      setNumber(label.values, "energy_kcal", /([\d.,]+)\s*kcal/i.exec(value)?.[1]);
    } else {
      const key = LABELS.find(([re]) => re.test(bare))?.[1];
      if (key && label.values[key] === undefined) setNumber(label.values, key, value);
      else if (!key) {
        const unit = /[\d.,]\s*([a-zµ%]+)\s*$/i.exec(value)?.[1] ?? null;
        label.extra.push({ name: bare, value: parseNumber(value), unit, raw: `${name}: ${value}` });
      }
    }
    name = null;
  });
  label.raw = rawLines.length ? rawLines.join("; ") : null;

  section.find(".product-edito").each((_, block) => {
    if (/^ingr[ée]dients$/i.test(cleanText($(block).find(".product-edito-title").first().text()) ?? ""))
      label.ingredients = cleanText($(block).find(".product-edito-main").first().text());
  });
  $("#edito-section-allergen p").each((_, p) => {
    const text = cleanText($(p).text()) ?? "";
    const present = /^pr[ée]sence\s*:\s*(.+)$/i.exec(text)?.[1];
    const traces = /^(?:traces|peut contenir)[^:]*:\s*(.+)$/i.exec(text)?.[1];
    if (present) label.allergens = cleanText(present);
    if (traces) label.traces = cleanText(traces);
  });
  label.nutriscore =
    /niveau\s*([A-E])\b/i.exec($(".badge-nutriscore").first().text())?.[1]?.toUpperCase() ?? null;
  label.dataOrigin = "store";
  const ean = usableEan(/"gtin13"\s*:\s*"(\d{8,14})"/.exec(html)?.[1]);
  return { label: finalizeLabel(label), ean };
}

/**
 * Chronodrive: Auchan group's drive, with Auchan's own brand and mainstream supermarket brands. Search (by text or
 * barcode) comes from the results page's data; labels from product pages.
 */
export class ChronodriveAdapter implements SourceAdapter {
  readonly id = "chronodrive" as const;
  readonly tier = "B" as const;
  readonly displayName = "Chronodrive";
  readonly capabilities = { text: true, ean: true };

  private readonly deps: AdapterDeps;

  constructor(deps: AdapterDeps) {
    this.deps = deps;
  }

  async search(query: SearchQuery): Promise<Offer[]> {
    const q = query.ean ?? query.text;
    if (!q) return [];
    const offers = await cachedSearch(this.deps, this.id, query, async () => {
      const res = await this.deps.http.getText(`${SITE}/search/${encodeURIComponent(q)}`, { headers: HTML });
      return parseChronodriveSearch(res.body, query.ean).slice(0, query.limit);
    });
    return matchingEan(offers, query.ean);
  }

  async getLabel(offer: Offer): Promise<LabelResult> {
    if (!offer.url) return { label: null };
    const url = offer.url;
    const { value } = await this.deps.cache.wrap<LabelResult>("label:chronodrive", url, TTL.label, async () =>
      parseChronodriveProduct(await this.productPage(url), url),
    );
    return value ?? { label: null };
  }

  private async productPage(url: string): Promise<string> {
    for (let attempt = 1; attempt <= PAGE_ATTEMPTS; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS * (attempt - 1)));
      const res = await this.deps.http.getText(url, { headers: HTML });
      if (hasProductDetails(res.body)) return res.body;
    }
    throw new Error("chronodrive: product page rendered without its details");
  }
}
