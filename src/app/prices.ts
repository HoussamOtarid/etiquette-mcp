import { parseNumber, round } from "../domain/numbers.ts";
import { parseQuantity } from "../domain/quantity.ts";
import type { Offer } from "../domain/types.ts";

export interface UnitPrice {
  value: number;
  unit: "kg" | "l";
}

export interface PricedOffer {
  offer: Offer;
  unitPrice: UnitPrice | null;
}

export interface PriceSpread {
  cheapest: number;
  most_expensive: number;
  savings_pct: number;
}

/**
 * Price per kg or litre: the shop's own unit price when it states one ("2,10€ le kg", "15,69 €/kg"), otherwise the
 * price divided by the pack size found in the size text or name.
 */
export function unitPriceOf(offer: Offer, fallbackSize: string | null = null): UnitPrice | null {
  const stated = /([\d\s.,]+)\s*€?\s*(?:\/|le|la|par)?\s*(kg|kilo|l|litre)\b/i.exec(
    offer.unitPriceText ?? "",
  );
  if (stated?.[1] && stated[2]) {
    const value = parseNumber(stated[1]);
    if (value !== null && value > 0)
      return { value: round(value, 2), unit: /^l/i.test(stated[2]) ? "l" : "kg" };
  }
  if (offer.priceEur === null) return null;
  const quantity = parseQuantity(offer.sizeText) ?? parseQuantity(offer.name) ?? parseQuantity(fallbackSize);
  if (!quantity || quantity.amount <= 0) return null;
  return {
    value: round(offer.priceEur / (quantity.amount / 1000), 2),
    unit: quantity.unit === "ml" ? "l" : "kg",
  };
}

/** Offers with a price, cheapest unit price first; offers without a comparable unit price come last, by price. */
export function rankByUnitPrice(offers: Offer[], fallbackSize: string | null = null): PricedOffer[] {
  return offers
    .filter((o) => o.priceEur !== null)
    .map((offer) => ({ offer, unitPrice: unitPriceOf(offer, fallbackSize) }))
    .sort((a, b) => {
      if (a.unitPrice && b.unitPrice) return a.unitPrice.value - b.unitPrice.value;
      if (a.unitPrice) return -1;
      if (b.unitPrice) return 1;
      return (a.offer.priceEur ?? 0) - (b.offer.priceEur ?? 0);
    });
}

export function spreadOf(ranked: PricedOffer[]): PriceSpread | null {
  const values = ranked.map((r) => r.unitPrice?.value).filter((v): v is number => v !== undefined);
  if (values.length < 2) return null;
  const cheapest = Math.min(...values);
  const mostExpensive = Math.max(...values);
  return {
    cheapest,
    most_expensive: mostExpensive,
    savings_pct: round(((mostExpensive - cheapest) / mostExpensive) * 100, 1),
  };
}

/** Cost of nutrition from a unit price and per-100 values: € per 100 kcal and € per 10 g of protein. */
export function valueForMoney(
  unitPrice: UnitPrice,
  per100: { energy_kcal?: number | null; protein_g?: number | null },
): { eur_per_100_kcal: number | null; eur_per_10g_protein: number | null } {
  const per100Price = unitPrice.value / 10;
  const kcal = per100.energy_kcal ?? 0;
  const protein = per100.protein_g ?? 0;
  return {
    eur_per_100_kcal: kcal > 0 ? round((per100Price * 100) / kcal, 3) : null,
    eur_per_10g_protein: protein > 0 ? round((per100Price * 10) / protein, 3) : null,
  };
}
