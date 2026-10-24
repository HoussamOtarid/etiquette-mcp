import { CORE_NUTRIENTS, NUTRIENT_LABELS_FR } from "../domain/nutrients.ts";
import type { DecidedLabel } from "./types.ts";

type AdviceInput = Pick<DecidedLabel, "nutrients" | "missing" | "confidence">;

/** Short, deterministic guidance for the calling model, derived from the decision indicators. */
export function buildAdvice({ nutrients, missing, confidence }: AdviceInput): string {
  const parts: string[] = [];
  const { overall, independentSources, selfCheck, flags } = confidence;

  if (overall === "none") {
    return "No nutrition label found in any source. Ask the user for the values printed on the pack.";
  }

  parts.push(
    independentSources === 1
      ? "Only one source has a label."
      : `${independentSources} independent sources have a label.`,
  );

  const conflicts = CORE_NUTRIENTS.filter((k) => nutrients[k]?.agreement === "conflict");
  if (conflicts.length > 0) {
    parts.push(
      `Sources disagree on ${conflicts.map((k) => NUTRIENT_LABELS_FR[k]).join(", ")}; no reliable value, ask the user to check the pack.`,
    );
  }

  const majorities = Object.values(nutrients).filter((n) => n?.agreement === "majority").length;
  if (majorities > 0) {
    parts.push(
      flags.includes("version_drift_suspected")
        ? `${majorities} nutrient(s) decided by majority; one source probably shows an older recipe.`
        : `${majorities} nutrient(s) decided by majority.`,
    );
  }

  if (selfCheck.failed.length > 0) {
    parts.push(`Label from ${selfCheck.failed.join(", ")} is internally inconsistent and was down-weighted.`);
  }
  if (flags.includes("assembled_label_inconsistent")) {
    parts.push("The combined label does not add up (energy vs macros); treat it with caution.");
  }

  if (flags.includes("basis_unknown")) {
    parts.push(
      "The label does not say whether values are per 100 g or 100 ml; check before scaling to a portion.",
    );
  } else if (flags.includes("basis_inferred")) {
    parts.push("The per-100 basis was inferred from the pack unit (g or ml), not stated on the label.");
  }

  const missingCore = missing.filter((k) => CORE_NUTRIENTS.includes(k));
  if (missingCore.length > 0) {
    parts.push(`Missing everywhere: ${missingCore.map((k) => NUTRIENT_LABELS_FR[k]).join(", ")}.`);
  }

  if (overall === "high") parts.push("Safe to log.");
  else if (overall === "medium") parts.push("Usable; mention to the user that it rests on limited evidence.");
  else parts.push("Low confidence: confirm with the user before logging.");

  return parts.join(" ");
}
