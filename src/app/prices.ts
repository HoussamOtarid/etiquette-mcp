import { round } from "../domain/numbers.ts";
import type { Offer } from "../domain/types.ts";

export interface PriceSpread {
  cheapest: number;
  most_expensive: number;
  savings_pct: number;
}

/** Offers with a price, cheapest first. */
export function rankByPrice(offers: Offer[]): Offer[] {
  return offers.filter((o) => o.priceEur !== null).sort((a, b) => (a.priceEur ?? 0) - (b.priceEur ?? 0));
}

export function spreadOf(ranked: Offer[]): PriceSpread | null {
  const values = ranked.map((o) => o.priceEur).filter((v): v is number => v !== null);
  if (values.length < 2) return null;
  const cheapest = Math.min(...values);
  const mostExpensive = Math.max(...values);
  return {
    cheapest,
    most_expensive: mostExpensive,
    savings_pct: round(((mostExpensive - cheapest) / mostExpensive) * 100, 1),
  };
}
