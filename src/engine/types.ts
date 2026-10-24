import type { NutrientKey } from "../domain/nutrients.ts";
import type { Basis, ExtraNutrient, SourceId, SourceLabel, Tier } from "../domain/types.ts";

/** Machine-readable flags explaining how a value or label was handled. */
export type Flag =
  | "salt_from_sodium"
  | "kj_kcal_swapped"
  | "energy_derived"
  | "zero_treated_as_missing"
  | "outlier_dropped"
  | "basis_converted"
  | "basis_unknown"
  | "self_check_failed"
  | "decimal_slip_suspected"
  | "zero_suspected"
  | "kj_inconsistent"
  | "basis_inferred"
  | "version_drift_suspected"
  | "single_source"
  | "copied_label_collapsed"
  | "assembled_label_inconsistent"
  | "core_nutrient_conflict";

export interface SelfCheckResult {
  status: "pass" | "fail" | "insufficient";
  kcalStated: number | null;
  kcalFromMacros: number | null;
  /** Nutrient most likely wrong by a factor of 10, when such a correction makes the label consistent. */
  decimalSlip?: { key: NutrientKey; stated: number; likely: number };
  /** Core macros stated as 0 that would explain the missing energy. */
  zeroSuspects?: NutrientKey[];
  kjKcalMismatch?: boolean;
  /** kcal agrees with the macros but kJ does not: the kJ value is likely wrong. */
  kjSuspect?: boolean;
}

/** One source's label after normalisation, ready to vote. */
export interface NormalizedLabel {
  source: SourceId;
  tier: Tier;
  basis: Basis;
  values: Partial<Record<NutrientKey, number>>;
  qualifiers: Partial<Record<NutrientKey, "lt" | "gt" | "traces">>;
  flags: Flag[];
  /** Notes about individual nutrients, e.g. "outlier_dropped:saturated_fat_g". */
  notes: string[];
  selfCheck: SelfCheckResult;
  weight: number;
  /** Labels with the same key are copies of each other and count as one vote. */
  independenceKey: string;
  original: SourceLabel;
}

export interface FlagDetail {
  flag: string;
  source: SourceId;
  nutrient?: NutrientKey;
  detail?: string;
}

export type Agreement = "strong" | "weak" | "majority" | "single" | "conflict";

export interface Vote {
  source: SourceId;
  value: number;
  weight: number;
}

export interface NutrientDecision {
  key: NutrientKey;
  /** Best value, or null on conflict. */
  value: number | null;
  agreement: Agreement;
  sourcesAgree: number;
  sourcesTotal: number;
  supporting: SourceId[];
  /** Sources counted as agreeing only within label tolerance, not within rounding of the chosen value. */
  weakOnly: SourceId[];
  dissent: Vote[];
  /** On conflict: the value from the most trustworthy source, offered as a hint only. */
  bestGuess?: number;
  qualifier?: "lt" | "gt" | "traces";
}

export type Confidence = "high" | "medium" | "low" | "none";

export interface DecidedLabel {
  basis: Basis;
  nutrients: Partial<Record<NutrientKey, NutrientDecision>>;
  missing: NutrientKey[];
  nutriscore: { value: string; sources: SourceId[] } | null;
  ingredients: { text: string; source: SourceId } | null;
  allergens: { text: string; source: SourceId } | null;
  traces: { text: string; source: SourceId } | null;
  extra: Array<ExtraNutrient & { source: SourceId }>;
  confidence: {
    overall: Confidence;
    sourcesWithLabel: number;
    independentSources: number;
    selfCheck: { passed: SourceId[]; failed: SourceId[]; insufficient: SourceId[] };
    flags: Flag[];
    /** Which source (and nutrient, when relevant) raised each per-source flag. */
    flagDetails: FlagDetail[];
  };
  advice: string;
  perSource: NormalizedLabel[];
}
