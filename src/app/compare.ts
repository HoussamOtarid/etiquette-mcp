import { round } from "../domain/numbers.ts";
import type { NutrientKey } from "../domain/nutrients.ts";
import { agreesStrongly, agreesWeakly } from "../engine/tolerance.ts";

export type ExpectedValues = Partial<Record<NutrientKey, number>>;

export type NutrientVerdict = "match" | "close" | "mismatch" | "no_data";

export interface ComparisonResult {
  /** match: all within rounding; close: within label tolerance; partial: some values missing on the label. */
  verdict: "match" | "close" | "mismatch" | "partial" | "no_data";
  nutrients: Partial<
    Record<
      NutrientKey,
      { expected: number; label: number | null; difference: number | null; verdict: NutrientVerdict }
    >
  >;
}

/** Compares values the user already has (e.g. a logged entry) with the decided label, nutrient by nutrient. */
export function compareWithLabel(
  expected: ExpectedValues,
  label: Partial<Record<NutrientKey, { value: number | null }>>,
): ComparisonResult {
  const nutrients: ComparisonResult["nutrients"] = {};
  for (const [key, value] of Object.entries(expected) as Array<[NutrientKey, number]>) {
    const actual = label[key]?.value ?? null;
    if (actual === null) {
      nutrients[key] = { expected: value, label: null, difference: null, verdict: "no_data" };
      continue;
    }
    const verdict: NutrientVerdict = agreesStrongly(key, value, actual)
      ? "match"
      : agreesWeakly(key, value, actual)
        ? "close"
        : "mismatch";
    nutrients[key] = { expected: value, label: actual, difference: round(actual - value, 2), verdict };
  }
  const verdicts = Object.values(nutrients).map((n) => n?.verdict);
  let verdict: ComparisonResult["verdict"];
  if (verdicts.length === 0 || verdicts.every((v) => v === "no_data")) verdict = "no_data";
  else if (verdicts.includes("mismatch")) verdict = "mismatch";
  else if (verdicts.includes("no_data")) verdict = "partial";
  else verdict = verdicts.includes("close") ? "close" : "match";
  return { verdict, nutrients };
}

const PREVIEW_KEYS = ["energy_kcal", "protein_g", "carbohydrates_g", "fat_g"] as const;
const MIN_COMPARED = 2;

/**
 * How a candidate's macro preview compares with the expected values: "match" (within label rounding) or "close"
 * (within label tolerance) on at least two macros, or null.
 */
export function previewVerdict(
  expected: ExpectedValues,
  preview: Partial<Record<(typeof PREVIEW_KEYS)[number], number | null>>,
): "match" | "close" | null {
  const label: Partial<Record<NutrientKey, { value: number | null }>> = {};
  const compared: ExpectedValues = {};
  for (const key of PREVIEW_KEYS) {
    const value = preview[key];
    if (expected[key] === undefined || value === null || value === undefined) continue;
    label[key] = { value };
    compared[key] = expected[key];
  }
  if (Object.keys(compared).length < MIN_COMPARED) return null;
  const { verdict } = compareWithLabel(compared, label);
  return verdict === "match" || verdict === "close" ? verdict : null;
}
