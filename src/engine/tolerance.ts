import type { NutrientKey } from "../domain/nutrients.ts";

/**
 * Agreement tolerances between two published labels.
 *
 * - "strong": the two values can be the same measurement rounded differently (EU rounding guidance,
 *   European Commission 2012: ≥10 g → nearest 1 g, 0.5–10 g → 0.1 g, salt ≥1 g → 0.1 g, …).
 * - "weak": within the EU tolerances accepted for declared values (same guidance document).
 *   Used to detect "same product, slightly different label version" rather than errors.
 */

const EPSILON = 1e-9;

function strongTolerance(key: NutrientKey, magnitude: number): number {
  switch (key) {
    case "energy_kcal":
      return Math.max(1, 0.005 * magnitude);
    case "energy_kj":
      return Math.max(4, 0.005 * magnitude);
    case "salt_g":
      return magnitude >= 1 ? 0.1 : 0.01;
    default:
      if (magnitude >= 10) return 1;
      if (magnitude >= 0.5) return 0.1;
      return 0.05;
  }
}

function weakTolerance(key: NutrientKey, magnitude: number): number {
  switch (key) {
    case "energy_kcal":
    case "energy_kj":
      return Math.max(key === "energy_kcal" ? 10 : 40, 0.1 * magnitude);
    case "fat_g":
      if (magnitude < 10) return 1.5;
      return magnitude <= 40 ? 0.2 * magnitude : 8;
    case "saturated_fat_g":
      return magnitude < 4 ? 0.8 : 0.2 * magnitude;
    case "salt_g":
      return magnitude < 1.25 ? 0.375 : 0.2 * magnitude;
    default:
      if (magnitude < 10) return 2;
      return magnitude <= 40 ? 0.2 * magnitude : 8;
  }
}

export function agreesStrongly(key: NutrientKey, a: number, b: number): boolean {
  return Math.abs(a - b) <= strongTolerance(key, Math.max(a, b)) + EPSILON;
}

export function agreesWeakly(key: NutrientKey, a: number, b: number): boolean {
  return Math.abs(a - b) <= weakTolerance(key, Math.max(a, b)) + EPSILON;
}
