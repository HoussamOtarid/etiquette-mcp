import { round } from "../domain/numbers.ts";
import { KJ_PER_KCAL, MASS_NUTRIENTS, type NutrientKey, SALT_PER_SODIUM } from "../domain/nutrients.ts";
import type { SourceLabel, Tier } from "../domain/types.ts";
import { selfCheck } from "./selfCheck.ts";
import type { Flag, NormalizedLabel } from "./types.ts";

const TIER_WEIGHT: Record<Tier, number> = { A: 1, B: 0.9, C: 0.8 };
const CROWD_WEIGHT = 0.8;
const FAILED_SELF_CHECK_FACTOR = 0.3;

const MAX_KCAL = 905; // pure fat ≈ 900 kcal/100 g
const MAX_KJ = 3800;

function addFlag(flags: Flag[], flag: Flag): void {
  if (!flags.includes(flag)) flags.push(flag);
}

/**
 * Turns one source label into comparable per-100 values and scores how much its votes should count.
 * Repairs what can be repaired safely (sodium → salt, swapped kJ/kcal) and drops impossible values.
 */
export function normalizeLabel(label: SourceLabel, tier: Tier): NormalizedLabel {
  const flags: Flag[] = [];
  const notes: string[] = [];
  const values: Partial<Record<NutrientKey, number>> = {};
  const qualifiers: NormalizedLabel["qualifiers"] = {};

  for (const [key, nutrient] of Object.entries(label.values) as Array<
    [NutrientKey, { value: number; qualifier?: "lt" | "gt" | "traces" }]
  >) {
    if (label.zeroMeansUnknown && nutrient.value === 0 && !nutrient.qualifier) {
      addFlag(flags, "zero_treated_as_missing");
      notes.push(`zero_treated_as_missing:${key}`);
      continue;
    }
    values[key] = nutrient.value;
    if (nutrient.qualifier) qualifiers[key] = nutrient.qualifier;
  }

  if (values.salt_g === undefined && label.sodiumG !== undefined) {
    values.salt_g = round(label.sodiumG * SALT_PER_SODIUM, 3);
    addFlag(flags, "salt_from_sodium");
  }

  const { energy_kj: kj, energy_kcal: kcal } = values;
  if (kj !== undefined && kcal !== undefined && kj < kcal) {
    values.energy_kj = kcal;
    values.energy_kcal = kj;
    addFlag(flags, "kj_kcal_swapped");
  }
  if (values.energy_kcal === undefined && values.energy_kj !== undefined) {
    values.energy_kcal = round(values.energy_kj / KJ_PER_KCAL, 0);
    addFlag(flags, "energy_derived");
  }

  const drop = (key: NutrientKey) => {
    delete values[key];
    delete qualifiers[key];
    addFlag(flags, "outlier_dropped");
    notes.push(`outlier_dropped:${key}`);
  };
  for (const key of MASS_NUTRIENTS) {
    const v = values[key];
    if (v !== undefined && (v < 0 || v > 100)) drop(key);
  }
  if (values.energy_kcal !== undefined && (values.energy_kcal < 0 || values.energy_kcal > MAX_KCAL))
    drop("energy_kcal");
  if (values.energy_kj !== undefined && (values.energy_kj < 0 || values.energy_kj > MAX_KJ))
    drop("energy_kj");
  if (
    values.saturated_fat_g !== undefined &&
    values.fat_g !== undefined &&
    values.saturated_fat_g > values.fat_g + 0.1
  )
    drop("saturated_fat_g");
  if (
    values.sugars_g !== undefined &&
    values.carbohydrates_g !== undefined &&
    values.sugars_g > values.carbohydrates_g + 0.5
  )
    drop("sugars_g");

  const check = selfCheck(values);
  let weight = TIER_WEIGHT[tier];
  if (label.dataOrigin === "crowd") weight *= CROWD_WEIGHT;
  if (check.status === "fail") {
    weight *= FAILED_SELF_CHECK_FACTOR;
    addFlag(flags, "self_check_failed");
    if (check.decimalSlip) {
      // The faulty value is known: drop it instead of letting it vote against correct sources.
      addFlag(flags, "decimal_slip_suspected");
      notes.push(`decimal_slip_dropped:${check.decimalSlip.key}`);
      delete values[check.decimalSlip.key];
      delete qualifiers[check.decimalSlip.key];
    }
  }

  return {
    source: label.source,
    tier,
    basis: label.basis,
    values,
    qualifiers,
    flags,
    notes,
    selfCheck: check,
    weight: round(weight, 3),
    independenceKey: label.copiedFrom ?? label.source,
    original: label,
  };
}
