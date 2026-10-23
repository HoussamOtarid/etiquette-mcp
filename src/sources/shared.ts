import { usableEan } from "../domain/ean.ts";
import { parseNutrientAmount } from "../domain/numbers.ts";
import type { NutrientKey } from "../domain/nutrients.ts";
import type { NutrientValue, Offer, SourceId } from "../domain/types.ts";
import { TTL } from "../infra/cache.ts";
import type { AdapterDeps, SearchQuery } from "./adapter.ts";

/** Caches a source's search results per query. */
export async function cachedSearch(
  deps: AdapterDeps,
  source: SourceId,
  query: SearchQuery,
  run: () => Promise<Offer[]>,
): Promise<Offer[]> {
  const key = JSON.stringify([query.ean ?? null, query.text ?? null, query.brand ?? null, query.limit]);
  const { value } = await deps.cache.wrap(`search:${source}`, key, TTL.search, async () => {
    const offers = await run();
    return offers.length > 0 ? offers : null;
  });
  return value ?? [];
}

/** Keeps only offers whose barcode equals the requested one (for sources whose text search also matches EANs). */
export function matchingEan(offers: Offer[], ean: string | undefined): Offer[] {
  if (!ean) return offers;
  return offers.filter((o) => o.ean === ean);
}

/** Sets a numeric nutrient value when present. */
export function setNumber(
  values: Partial<Record<NutrientKey, NutrientValue>>,
  key: NutrientKey,
  raw: unknown,
): void {
  if (raw === null || raw === undefined || raw === "") return;
  if (typeof raw === "number") {
    if (Number.isFinite(raw)) values[key] = { value: raw };
    return;
  }
  const parsed = parseNutrientAmount(String(raw));
  if (parsed) values[key] = parsed;
}

export function firstString(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
}

export function eanOf(value: unknown): string | null {
  return usableEan(firstString(value));
}

export function priceOf(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
