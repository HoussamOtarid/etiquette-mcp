import { round } from "../domain/numbers.ts";
import { KJ_PER_KCAL, type NutrientKey } from "../domain/nutrients.ts";
import type { SelfCheckResult } from "./types.ts";

type Values = Partial<Record<NutrientKey, number>>;

/** Atwater factors: fat 9, carbohydrate 4, protein 4, fibre 2 kcal/g (EU Regulation 1169/2011, Annex XIV). */
export function kcalFromMacros(values: Values): number | null {
  const { fat_g: fat, carbohydrates_g: carbs, protein_g: protein } = values;
  if (fat === undefined || carbs === undefined || protein === undefined) return null;
  return 9 * fat + 4 * carbs + 4 * protein + 2 * (values.fiber_g ?? 0);
}

function energyConsistent(stated: number, computed: number): boolean {
  return Math.abs(stated - computed) <= Math.max(15, 0.15 * Math.max(stated, computed));
}

const SLIP_CANDIDATES: NutrientKey[] = ["fat_g", "carbohydrates_g", "protein_g"];

/**
 * Checks a label against itself: stated energy vs energy computed from macros, and kJ vs kcal.
 * When the energy check fails, tries a ×10 / ÷10 correction on each macro to spot decimal slips.
 */
export function selfCheck(values: Values): SelfCheckResult {
  const stated = values.energy_kcal ?? null;
  const computed = kcalFromMacros(values);
  const result: SelfCheckResult = {
    status: "insufficient",
    kcalStated: stated,
    kcalFromMacros: computed === null ? null : round(computed, 1),
  };

  if (values.energy_kj !== undefined && stated !== null) {
    const expectedKj = stated * KJ_PER_KCAL;
    if (Math.abs(values.energy_kj - expectedKj) > Math.max(10, 0.05 * expectedKj))
      result.kjKcalMismatch = true;
  }

  if (stated === null || computed === null) {
    if (result.kjKcalMismatch) result.status = "fail";
    return result;
  }

  if (energyConsistent(stated, computed) && !result.kjKcalMismatch) {
    result.status = "pass";
    return result;
  }

  result.status = "fail";
  for (const key of SLIP_CANDIDATES) {
    const original = values[key];
    if (original === undefined || original === 0) continue;
    for (const factor of [10, 0.1]) {
      const likely = round(original * factor, 3);
      const recomputed = kcalFromMacros({ ...values, [key]: likely });
      if (recomputed !== null && energyConsistent(stated, recomputed) && likely <= 100) {
        result.decimalSlip = { key, stated: original, likely };
        return result;
      }
    }
  }
  return result;
}
