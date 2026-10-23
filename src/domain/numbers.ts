import type { NutrientValue } from "./types.ts";

/**
 * Parses a number as written on French labels: "4,7", "1 121", "1 121", "0.5".
 * Returns null when no number is present.
 */
export function parseNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = /(\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)/.exec(text);
  if (!match?.[1]) return null;
  const value = Number(match[1].replace(/[   ]/g, "").replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses a nutrient amount including qualifiers: "<0,5 g" → {0.5, lt}, "traces" → {0, traces}, "?" → null.
 */
export function parseNutrientAmount(text: string | null | undefined): NutrientValue | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (/^traces?\b/i.test(trimmed) || /^tr\.?$/i.test(trimmed)) return { value: 0, qualifier: "traces" };
  const value = parseNumber(trimmed);
  if (value === null) return null;
  if (/^<|inf[ée]rieur|moins de/i.test(trimmed)) return { value, qualifier: "lt" };
  if (/^>/.test(trimmed)) return { value, qualifier: "gt" };
  return { value };
}

export function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
