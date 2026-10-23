import { createHash } from "node:crypto";
import { parseQuantity, sameQuantity } from "../domain/quantity.ts";
import { sameBrand, tokenSimilarity } from "../domain/text.ts";
import type { Offer, SourceId, Tier } from "../domain/types.ts";

export type MatchKind = "ean" | "name_brand_size" | "single_offer";

export interface ProductGroup {
  /** Stable reference: "ean:<ean>" or "grp:<hash>". */
  ref: string;
  ean: string | null;
  name: string;
  brand: string | null;
  sizeText: string | null;
  match: MatchKind;
  offers: Offer[];
}

/** Minimum name similarity for two offers without barcodes to be considered the same product. */
const SAME_PRODUCT_NAME_SIMILARITY = 0.5;

function sameProduct(a: Offer, b: Offer): boolean {
  if (a.ean && b.ean) return a.ean === b.ean;
  if (sameBrand(a.brand, b.brand) !== true) return false;
  const size = sameQuantity(parseQuantity(a.sizeText ?? a.name), parseQuantity(b.sizeText ?? b.name));
  if (size === false) return false;
  return tokenSimilarity(a.name, b.name) >= SAME_PRODUCT_NAME_SIMILARITY;
}

function mostCommon<T>(values: Array<T | null>): T | null {
  const counts = new Map<T, number>();
  for (const v of values) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function groupRef(offers: Offer[], ean: string | null): string {
  if (ean) return `ean:${ean}`;
  const seed = offers
    .map((o) => `${o.source}:${o.sourceProductId}`)
    .sort()
    .join("|");
  return `grp:${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

/**
 * Groups offers from several sources into products. Offers sharing a barcode are the same product; offers without
 * a barcode join a group only when brand, pack size and name all match. Different brands are never merged.
 */
export function groupOffers(offers: Offer[], tierOf: (s: SourceId) => Tier): ProductGroup[] {
  const groups: Offer[][] = [];
  for (const offer of offers) {
    const home = offer.ean
      ? (groups.find((g) => g.some((o) => o.ean === offer.ean)) ??
        // A barcoded offer may join a group that has no barcode yet, on brand + size + name.
        groups.find((g) => g.every((o) => !o.ean) && g.some((o) => sameProduct(o, offer))))
      : groups.find((g) => g.some((o) => sameProduct(o, offer)));
    if (home) home.push(offer);
    else groups.push([offer]);
  }
  const tierRank = { A: 0, B: 1, C: 2 } as const;
  return groups.map((members) => {
    const ean = members.find((o) => o.ean)?.ean ?? null;
    const byTier = [...members].sort((a, b) => tierRank[tierOf(a.source)] - tierRank[tierOf(b.source)]);
    const match: MatchKind =
      members.length === 1 ? "single_offer" : members.every((o) => o.ean === ean) ? "ean" : "name_brand_size";
    return {
      ref: groupRef(members, ean),
      ean,
      name: byTier[0]?.name ?? "",
      brand: mostCommon(members.map((o) => o.brand)),
      sizeText: mostCommon(members.map((o) => o.sizeText)),
      match,
      offers: members,
    };
  });
}

export interface RankOptions {
  query: string;
  brand?: string;
  size?: string;
}

/** Relevance of a product group to a free-text query (higher is better). */
export function scoreGroup(group: ProductGroup, { query, brand, size }: RankOptions): number {
  const nameScore = Math.max(
    0,
    ...group.offers.map((o) => tokenSimilarity(query, `${o.name} ${o.brand ?? ""}`)),
  );
  let score = nameScore;
  const brandMatch = brand ? sameBrand(brand, group.brand) : null;
  if (brandMatch === true) score += 0.3;
  if (brandMatch === false) score -= 0.3;
  if (size) {
    const sizeMatch = sameQuantity(parseQuantity(size), parseQuantity(group.sizeText ?? group.name));
    if (sizeMatch === true) score += 0.15;
    if (sizeMatch === false) score -= 0.15;
  }
  score += Math.min(0.2, 0.05 * new Set(group.offers.map((o) => o.source)).size);
  if (group.ean) score += 0.05;
  return Math.round(score * 1000) / 1000;
}

export function rankGroups(
  groups: ProductGroup[],
  options: RankOptions,
): Array<ProductGroup & { score: number }> {
  return groups.map((g) => ({ ...g, score: scoreGroup(g, options) })).sort((a, b) => b.score - a.score);
}

/** The query designates one product unambiguously (clear winner). */
export function isUnambiguous(ranked: Array<{ score: number }>): boolean {
  const [first, second] = ranked;
  if (!first) return false;
  if (!second) return first.score >= 0.4;
  return first.score >= 0.5 && first.score - second.score >= 0.25;
}
