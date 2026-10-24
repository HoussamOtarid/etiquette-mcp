import { unflatten } from "devalue";
import { usableEan } from "../domain/ean.ts";
import type { NutrientKey } from "../domain/nutrients.ts";
import type { Basis, Offer, SourceLabel } from "../domain/types.ts";
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

interface ListedProduct {
  id?: string;
  eans?: string[];
  labels?: { productLabel?: string; brandLabel?: string; unitQuantityLabel?: string };
  prices?: { defaultPrice?: number };
  stock?: string;
  characteristics?: { features?: Array<{ code?: string; value?: unknown }> };
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

/**
 * Product characteristics carrying the label, by code (checked against the product pages: values per 100 g/ml as
 * printed, energy in kJ and kcal, masses in grams).
 */
const NUTRIENT_FEATURES: Record<string, NutrientKey> = {
  "157": "energy_kj",
  "243": "energy_kcal",
  "159": "fat_g",
  "160": "saturated_fat_g",
  "163": "carbohydrates_g",
  "164": "sugars_g",
  "167": "fiber_g",
  "168": "protein_g",
  "169": "salt_g",
};
const BASIS_FEATURE = "563";
const ALLERGENS_FEATURE = "383";
const NUTRISCORE_FEATURE = "520";

/** All barcodes of a listed product; some entries hold several, separated by spaces. */
function barcodesOf(product: ListedProduct): string[] {
  const codes = (product.eans ?? []).flatMap((e) => e.split(/\s+/)).map((e) => usableEan(e));
  return [...new Set(codes.filter((e): e is string => e !== null))];
}

/** "100 g", "100ml" or "100.000 GR"; anything else (the field sometimes holds other text) gives null. */
function basisOf(text: string | undefined): Basis | null {
  const m = /^100(?:[.,]0+)?\s*(g|gr|ml)$/i.exec(text?.trim() ?? "");
  if (!m) return null;
  return m[1]?.toLowerCase() === "ml" ? "100ml" : "100g";
}

/** "Contient : Lait. Peut contenir : Soja" or "Présence : LAIT" → allergens and traces. */
function allergensOf(text: string | undefined): { allergens: string | null; traces: string | null } {
  const value = text ?? "";
  const traces = /peut contenir\s*:\s*(.*)$/i.exec(value)?.[1];
  const present = /(?:contient|pr[ée]sence)\s*:\s*(.*?)(?:\.?\s*peut contenir\s*:.*)?$/i.exec(value)?.[1];
  const tidy = (s: string | undefined) => cleanText(s?.replace(/\.\s*$/, ""));
  return { allergens: tidy(present), traces: tidy(traces) };
}

/** The label carried by a listed product's characteristics, or undefined when it has no nutrition values. */
function labelOf(product: ListedProduct, url: string, sizeText: string | null): SourceLabel | undefined {
  const features = new Map<string, string>();
  for (const f of product.characteristics?.features ?? [])
    if (f.code && typeof f.value === "string") features.set(f.code, f.value);
  const label = emptyLabel("chronodrive", url);
  for (const [code, key] of Object.entries(NUTRIENT_FEATURES))
    setNumber(label.values, key, features.get(code));
  if (Object.keys(label.values).length === 0) return undefined;
  label.basis =
    basisOf(features.get(BASIS_FEATURE)) ?? (/\d\s*(?:ml|cl|l)\b/i.test(sizeText ?? "") ? "100ml" : "100g");
  label.raw = Object.entries(NUTRIENT_FEATURES)
    .filter(([code]) => features.has(code))
    .map(([code, key]) => `${key}: ${features.get(code)}`)
    .join("; ");
  Object.assign(label, allergensOf(features.get(ALLERGENS_FEATURE)));
  const grade = features.get(NUTRISCORE_FEATURE)?.trim().toUpperCase();
  label.nutriscore = grade && /^[A-E]$/.test(grade) ? grade : null;
  label.dataOrigin = "store";
  return finalizeLabel(label);
}

/** Search results, with their labels, live in the page's Nuxt payload; product links are in the rendered cards. */
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
    const url = `${SITE}${links.get(product.id) ?? `/produit-P${product.id}`}`;
    const sizeText = cleanText(product.labels?.unitQuantityLabel);
    const label = labelOf(product, url, sizeText);
    return [
      {
        source: "chronodrive" as const,
        sourceProductId: product.id,
        url,
        name,
        brand: cleanText(product.labels?.brandLabel),
        ean,
        sizeText,
        priceEur: priceOf(product.prices?.defaultPrice),
        inStock: product.stock ? !/out|no_stock|unavailable/i.test(product.stock) : null,
        ...(label ? { label } : {}),
      },
    ];
  });
}

/**
 * Chronodrive: Auchan group's drive, with Auchan's own brand and mainstream supermarket brands. A search (by text or
 * barcode) returns the products with their labels in one request.
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
      const res = await this.deps.http.getText(`${SITE}/search/${encodeURIComponent(q)}`, {
        headers: { accept: "text/html,application/xhtml+xml" },
      });
      return parseChronodriveSearch(res.body, query.ean).slice(0, query.limit);
    });
    return matchingEan(offers, query.ean);
  }

  async getLabel(offer: Offer): Promise<LabelResult> {
    return { label: offer.label ?? null };
  }
}
