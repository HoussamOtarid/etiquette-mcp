export interface Quantity {
  amount: number;
  unit: "g" | "ml";
}

const UNIT_FACTORS: Record<string, { unit: "g" | "ml"; factor: number }> = {
  g: { unit: "g", factor: 1 },
  gr: { unit: "g", factor: 1 },
  kg: { unit: "g", factor: 1000 },
  ml: { unit: "ml", factor: 1 },
  cl: { unit: "ml", factor: 10 },
  dl: { unit: "ml", factor: 100 },
  l: { unit: "ml", factor: 1000 },
};

/**
 * Extracts the total package quantity from a product name or size text:
 * "4 x 125 g" → 500 g, "Muesli 350g Bio" → 350 g, "1,5 L" → 1500 ml, "(x 16, 285 g)" → 285 g.
 */
export function parseQuantity(text: string | null | undefined): Quantity | null {
  if (!text) return null;
  const t = text.toLowerCase().replace(/,/g, ".").replace(/\u00a0/g, " ");
  const multi = /(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|gr|g|ml|cl|dl|l)\b/.exec(t);
  if (multi?.[1] && multi[2] && multi[3]) {
    const unit = UNIT_FACTORS[multi[3]];
    if (unit)
      return { amount: Math.round(Number(multi[1]) * Number(multi[2]) * unit.factor), unit: unit.unit };
  }
  const single = /(\d+(?:\.\d+)?)\s*(kg|gr|g|ml|cl|dl|l)\b/.exec(t);
  if (single?.[1] && single[2]) {
    const unit = UNIT_FACTORS[single[2]];
    if (unit) return { amount: Math.round(Number(single[1]) * unit.factor), unit: unit.unit };
  }
  return null;
}

/** Two quantities refer to the same pack size (±5%, same unit family). */
export function sameQuantity(a: Quantity | null, b: Quantity | null): boolean | null {
  if (!a || !b) return null;
  if (a.unit !== b.unit) return null;
  return Math.abs(a.amount - b.amount) <= 0.05 * Math.max(a.amount, b.amount);
}
