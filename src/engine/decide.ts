import { CORE_NUTRIENTS, isNutrientKey, NUTRIENT_KEYS, type NutrientKey } from "../domain/nutrients.ts";
import type { SourceId, SourceLabel, Tier } from "../domain/types.ts";
import { buildAdvice } from "./advice.ts";
import { alignBasis } from "./basis.ts";
import { normalizeLabel } from "./normalize.ts";
import { selfCheck } from "./selfCheck.ts";
import type {
  Confidence,
  DecidedLabel,
  Flag,
  FlagDetail,
  NormalizedLabel,
  NutrientDecision,
} from "./types.ts";
import { decideNutrient } from "./vote.ts";

export interface DecideInput {
  labels: SourceLabel[];
  productName: string;
  tierOf: (source: SourceId) => Tier;
}

const TIER_RANK: Record<Tier, number> = { A: 3, B: 2, C: 1 };

function pickText(
  labels: NormalizedLabel[],
  field: "ingredients" | "allergens" | "traces",
): { text: string; source: SourceId } | null {
  const candidates = labels
    .filter((l) => l.original[field])
    .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.weight - a.weight);
  const best = candidates[0];
  const text = best?.original[field];
  return best && text ? { text, source: best.source } : null;
}

function pickNutriscore(labels: NormalizedLabel[]): DecidedLabel["nutriscore"] {
  const counts = new Map<string, SourceId[]>();
  for (const l of labels) {
    const grade = l.original.nutriscore?.trim().toUpperCase();
    if (grade && /^[A-E]$/.test(grade)) counts.set(grade, [...(counts.get(grade) ?? []), l.source]);
  }
  const [best] = [...counts.entries()].sort((a, b) => b[1].length - a[1].length);
  return best ? { value: best[0], sources: best[1] } : null;
}

/** Per-source flags with the nutrient or detail recorded in that source's notes ("flag:nutrient"). */
function flagDetailsOf(label: NormalizedLabel): FlagDetail[] {
  const fromNotes = label.notes.map((note) => {
    const [flag = note, rest] = note.split(":");
    const detail: FlagDetail = { flag, source: label.source };
    if (rest && isNutrientKey(rest)) detail.nutrient = rest;
    else if (rest) detail.detail = rest;
    return detail;
  });
  const noted = new Set(fromNotes.map((d) => d.flag));
  const plain = label.flags.filter((f) => !noted.has(f)).map((flag) => ({ flag, source: label.source }));
  return [...fromNotes, ...plain];
}

function confidenceOf(
  nutrients: Partial<Record<NutrientKey, NutrientDecision>>,
  independent: number,
  assembledOk: boolean,
  onlyLabelPassed: boolean,
): Confidence {
  const core = CORE_NUTRIENTS.map((k) => nutrients[k]);
  if (core.every((n) => !n || n.value === null) && independent === 0) return "none";
  if (core.some((n) => !n)) return independent === 0 ? "none" : "low";
  const coreSettled = core.every((n) => n && ["strong", "weak", "majority"].includes(n.agreement));
  if (independent >= 2 && coreSettled && assembledOk) return "high";
  if (independent === 1) return onlyLabelPassed && assembledOk ? "medium" : "low";
  if (assembledOk && core.every((n) => n && n.value !== null)) return "medium";
  return "low";
}

/**
 * Combines the labels of the same product from several sources into one best label, with per-nutrient agreement,
 * an overall confidence, flags and advice for the caller.
 */
export function decideLabel({ labels, productName, tierOf }: DecideInput): DecidedLabel {
  const normalized = labels
    .filter((l) => Object.keys(l.values).length > 0 || l.sodiumG !== undefined)
    .map((l) => normalizeLabel(l, tierOf(l.source)));
  const { basis, labels: aligned } = alignBasis(normalized, productName);
  const flags = new Set<Flag>();

  const nutrients: Partial<Record<NutrientKey, NutrientDecision>> = {};
  const missing: NutrientKey[] = [];
  for (const key of NUTRIENT_KEYS) {
    const votes = aligned
      .filter((l) => l.values[key] !== undefined)
      .map((l) => ({
        source: l.source,
        value: l.values[key] as number,
        weight: l.weight,
        independenceKey: l.independenceKey,
      }));
    if (votes.length === 0) {
      missing.push(key);
      continue;
    }
    const { collapsed, ...decision } = decideNutrient(key, votes);
    if (collapsed) flags.add("copied_label_collapsed");
    const qualifier = aligned.find((l) => l.source === decision.supporting[0])?.qualifiers[key];
    nutrients[key] = qualifier ? { ...decision, qualifier } : decision;
  }

  // A source that keeps deviating (outvoted, or only within tolerance) while others agree on the exact values
  // most likely shows another version of the recipe.
  const deviations = new Map<SourceId, number>();
  for (const n of Object.values(nutrients)) {
    if (!n || n.sourcesTotal < 3) continue;
    const deviating = [...n.weakOnly, ...(n.agreement === "majority" ? n.dissent.map((d) => d.source) : [])];
    for (const s of deviating) deviations.set(s, (deviations.get(s) ?? 0) + 1);
  }
  if ([...deviations.values()].some((c) => c >= 2)) flags.add("version_drift_suspected");
  if (CORE_NUTRIENTS.some((k) => nutrients[k]?.agreement === "conflict")) flags.add("core_nutrient_conflict");

  const assembled: Partial<Record<NutrientKey, number>> = {};
  for (const [key, n] of Object.entries(nutrients) as Array<[NutrientKey, NutrientDecision]>) {
    const v = n.value ?? n.bestGuess;
    if (v !== undefined && v !== null) assembled[key] = v;
  }
  const assembledCheck = selfCheck(assembled);
  const assembledOk = assembledCheck.status !== "fail";
  if (!assembledOk) flags.add("assembled_label_inconsistent");

  const independentSources = new Set(aligned.map((l) => l.independenceKey)).size;
  if (independentSources === 1) flags.add("single_source");
  for (const l of aligned) for (const f of l.flags) flags.add(f);

  const passed = aligned.filter((l) => l.selfCheck.status === "pass").map((l) => l.source);
  const failed = aligned.filter((l) => l.selfCheck.status === "fail").map((l) => l.source);
  const insufficient = aligned.filter((l) => l.selfCheck.status === "insufficient").map((l) => l.source);

  const flagDetails = aligned.flatMap((l) => flagDetailsOf(l));
  const overall = confidenceOf(nutrients, independentSources, assembledOk, failed.length === 0);
  const confidence: DecidedLabel["confidence"] = {
    overall,
    sourcesWithLabel: aligned.length,
    independentSources,
    selfCheck: { passed, failed, insufficient },
    flags: [...flags],
    flagDetails,
  };

  const extra = aligned.flatMap((l) => l.original.extra.map((e) => ({ ...e, source: l.source })));

  return {
    basis,
    nutrients,
    missing,
    nutriscore: pickNutriscore(aligned),
    ingredients: pickText(aligned, "ingredients"),
    allergens: pickText(aligned, "allergens"),
    traces: pickText(aligned, "traces"),
    extra,
    confidence,
    advice: buildAdvice({ nutrients, missing, confidence }),
    perSource: aligned,
  };
}
