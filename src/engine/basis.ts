import { round } from "../domain/numbers.ts";
import { MASS_NUTRIENTS, type NutrientKey } from "../domain/nutrients.ts";
import { normalizeText } from "../domain/text.ts";
import type { Basis } from "../domain/types.ts";
import type { NormalizedLabel } from "./types.ts";

/** Approximate densities (g/ml) by product family, used only to compare a 100 ml label with a 100 g one. */
const DENSITIES: Array<{ pattern: RegExp; density: number }> = [
  { pattern: /\bhuile|\boil\b/, density: 0.91 },
  { pattern: /\bsirop|\bmiel\b/, density: 1.35 },
  { pattern: /\blait\b|\bboisson\b|\bdrink\b|\bkefir|\bcreme\b/, density: 1.03 },
  { pattern: /\bjus\b|\bnectar|\bsmoothie|\bsoda|\bkombucha|\blimonade/, density: 1.04 },
];

export function densityFor(productName: string): number {
  const name = normalizeText(productName);
  return DENSITIES.find((d) => d.pattern.test(name))?.density ?? 1;
}

function family(basis: Basis): "g" | "ml" | "either" | "unknown" {
  if (basis === "100g") return "g";
  if (basis === "100ml") return "ml";
  if (basis === "100g/100ml") return "either";
  return "unknown";
}

/**
 * Brings all labels to one basis. The target is the most common explicit basis; labels on the other basis are
 * converted with a density estimate (and flagged). Labels stating "100 g / 100 ml" or no basis are kept as is.
 */
export function alignBasis(
  labels: NormalizedLabel[],
  productName: string,
): { basis: Basis; labels: NormalizedLabel[] } {
  const grams = labels.filter((l) => family(l.basis) === "g").length;
  const millis = labels.filter((l) => family(l.basis) === "ml").length;
  const target: Basis =
    grams === 0 && millis === 0 ? (labels[0]?.basis ?? "unknown") : grams >= millis ? "100g" : "100ml";
  const density = densityFor(productName);

  const aligned = labels.map((label) => {
    const fam = family(label.basis);
    if (fam === "unknown")
      return { ...label, flags: [...new Set([...label.flags, "basis_unknown" as const])] };
    if (fam === "either" || label.basis === target || (target !== "100g" && target !== "100ml")) return label;
    // per 100 ml → per 100 g: divide by density; per 100 g → per 100 ml: multiply.
    const factor = target === "100g" ? 1 / density : density;
    const values: Partial<Record<NutrientKey, number>> = {};
    for (const [key, value] of Object.entries(label.values) as Array<[NutrientKey, number]>) {
      const isMassOrEnergy = MASS_NUTRIENTS.includes(key) || key === "energy_kcal" || key === "energy_kj";
      values[key] = isMassOrEnergy ? round(value * factor, 2) : value;
    }
    return {
      ...label,
      values,
      basis: target,
      flags: [...new Set([...label.flags, "basis_converted" as const])],
    };
  });
  return { basis: target, labels: aligned };
}
