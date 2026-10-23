import { describe, expect, it } from "vitest";
import type { NutrientKey } from "../../src/domain/nutrients.ts";
import type { Basis, SourceId, SourceLabel, Tier } from "../../src/domain/types.ts";
import { decideLabel } from "../../src/engine/decide.ts";
import { normalizeLabel } from "../../src/engine/normalize.ts";
import { selfCheck } from "../../src/engine/selfCheck.ts";
import { agreesStrongly, agreesWeakly } from "../../src/engine/tolerance.ts";

type Short = Partial<
  Record<"kj" | "kcal" | "fat" | "sat" | "carbs" | "sugars" | "fiber" | "protein" | "salt", number>
>;
const KEYS: Record<keyof Short, NutrientKey> = {
  kj: "energy_kj",
  kcal: "energy_kcal",
  fat: "fat_g",
  sat: "saturated_fat_g",
  carbs: "carbohydrates_g",
  sugars: "sugars_g",
  fiber: "fiber_g",
  protein: "protein_g",
  salt: "salt_g",
};

function label(
  source: SourceId,
  v: Short,
  extra: Partial<SourceLabel> & { basis?: Basis } = {},
): SourceLabel {
  const values: SourceLabel["values"] = {};
  for (const [k, value] of Object.entries(v) as Array<[keyof Short, number]>) values[KEYS[k]] = { value };
  return {
    source,
    basis: "100g",
    values,
    extra: [],
    raw: null,
    ingredients: null,
    allergens: null,
    traces: null,
    nutriscore: null,
    parseStatus: "ok",
    url: null,
    fetchedAt: "2026-10-23T00:00:00Z",
    ...extra,
  };
}

const TIERS: Record<SourceId, Tier> = {
  off: "A",
  lafourche: "A",
  kazidomi: "A",
  biocoop: "B",
  lavieclaire: "B",
  naturalia: "C",
  labellevie: "C",
};
const decide = (labels: SourceLabel[], productName = "produit") =>
  decideLabel({ labels, productName, tierOf: (s) => TIERS[s] });

describe("tolerances", () => {
  it("treats label rounding as strong agreement", () => {
    expect(agreesStrongly("sugars_g", 11, 10)).toBe(true);
    expect(agreesStrongly("protein_g", 6.8, 6.5)).toBe(false);
    expect(agreesStrongly("energy_kcal", 229, 230)).toBe(true);
    expect(agreesStrongly("salt_g", 0.12, 0.13)).toBe(true);
  });

  it("uses EU declared-value tolerances for weak agreement", () => {
    expect(agreesWeakly("protein_g", 6.8, 6.5)).toBe(true);
    expect(agreesWeakly("carbohydrates_g", 44, 47.7)).toBe(true);
    expect(agreesWeakly("energy_kcal", 112, 88)).toBe(false);
  });
});

describe("self-check", () => {
  it("passes a consistent label", () => {
    expect(selfCheck({ energy_kcal: 43, fat_g: 1, carbohydrates_g: 4.7, protein_g: 3.8 }).status).toBe(
      "pass",
    );
  });

  it("pins a decimal slip on the faulty macro", () => {
    const result = selfCheck({ energy_kcal: 440, fat_g: 1.3, carbohydrates_g: 74, protein_g: 9.6 });
    expect(result.status).toBe("fail");
    expect(result.decimalSlip).toEqual({ key: "fat_g", stated: 1.3, likely: 13 });
  });

  it("reports insufficient data instead of guessing", () => {
    expect(selfCheck({ energy_kcal: 54 }).status).toBe("insufficient");
  });
});

describe("normalisation", () => {
  it("repairs swapped kJ/kcal", () => {
    const n = normalizeLabel(
      label("lavieclaire", { kj: 498, kcal: 2071, fat: 30, carbs: 45, protein: 6 }),
      "B",
    );
    expect(n.values.energy_kcal).toBe(498);
    expect(n.values.energy_kj).toBe(2071);
    expect(n.flags).toContain("kj_kcal_swapped");
  });

  it("derives salt from sodium", () => {
    const n = normalizeLabel(
      label("naturalia", { kcal: 564, fat: 48.6, carbs: 9.3, protein: 20.95 }, { sodiumG: 0.78 }),
      "C",
    );
    expect(n.values.salt_g).toBe(1.95);
    expect(n.flags).toContain("salt_from_sodium");
  });

  it("treats zeros as unknown for sources that default to 0", () => {
    const n = normalizeLabel(
      label("kazidomi", { kcal: 350, fat: 1, carbs: 72, protein: 12, salt: 0 }, { zeroMeansUnknown: true }),
      "A",
    );
    expect(n.values.salt_g).toBeUndefined();
    expect(n.flags).toContain("zero_treated_as_missing");
  });

  it("drops impossible values", () => {
    const n = normalizeLabel(
      label("kazidomi", { kcal: 560, fat: 40, sat: 45175, carbs: 40, protein: 10 }),
      "A",
    );
    expect(n.values.saturated_fat_g).toBeUndefined();
    expect(n.notes).toContain("outlier_dropped:saturated_fat_g");
  });
});

describe("decision", () => {
  it("settles a 2-of-3 majority and spots an outdated label (Montignac bread)", () => {
    const d = decide([
      label("naturalia", {
        kcal: 230,
        fat: 1.0,
        sat: 0.2,
        carbs: 44,
        sugars: 1.1,
        fiber: 8.8,
        protein: 6.8,
        salt: 1.3,
      }),
      label("labellevie", {
        kcal: 229,
        fat: 1.4,
        sat: 0.3,
        carbs: 47.7,
        sugars: 1.9,
        fiber: 8.8,
        protein: 6.5,
        salt: 1.0,
      }),
      label("off", {
        kcal: 230,
        fat: 1,
        sat: 0.2,
        carbs: 44,
        sugars: 1.1,
        fiber: 8.8,
        protein: 6.8,
        salt: 1.3,
      }),
    ]);
    expect(d.nutrients.energy_kcal?.agreement).toBe("strong");
    expect(d.nutrients.salt_g).toMatchObject({ value: 1.3, agreement: "majority", sourcesAgree: 2 });
    expect(d.nutrients.salt_g?.dissent[0]?.source).toBe("labellevie");
    expect(d.confidence.flags).toContain("version_drift_suspected");
    expect(d.confidence.overall).toBe("high");
  });

  it("drops a decimal slip instead of creating a conflict (Biocoop biscuits)", () => {
    const d = decide([
      label("biocoop", { kcal: 440, fat: 1.3, sat: 0.3, carbs: 74, protein: 9.6 }),
      label("off", { kcal: 440, fat: 13, sat: 8.6, carbs: 74, protein: 9.6 }),
    ]);
    expect(d.nutrients.fat_g).toMatchObject({ value: 13, agreement: "single" });
    expect(d.confidence.selfCheck.failed).toEqual(["biocoop"]);
    expect(d.confidence.flags).toContain("decimal_slip_suspected");
  });

  it("aligns 100 ml and 100 g labels (olive oil)", () => {
    const d = decide(
      [
        label("lafourche", { kcal: 900, fat: 100, sat: 17, carbs: 0, protein: 0 }),
        label("off", { kcal: 822, fat: 91, sat: 15, carbs: 0, protein: 0 }, { basis: "100ml" }),
      ],
      "Huile d'olive vierge extra",
    );
    expect(d.basis).toBe("100g");
    expect(d.confidence.flags).toContain("basis_converted");
    expect(d.nutrients.fat_g?.agreement).toMatch(/strong|weak/);
    expect(d.nutrients.energy_kcal?.agreement).toMatch(/strong|weak/);
  });

  it("refuses to pick between two disagreeing sources", () => {
    const d = decide([
      label("lavieclaire", { kcal: 112, fat: 0.5, carbs: 26, protein: 0.8 }),
      label("off", { kcal: 88, fat: 0.5, carbs: 20.2, protein: 0.5 }),
    ]);
    expect(d.nutrients.energy_kcal).toMatchObject({ value: null, agreement: "conflict" });
    expect(d.nutrients.energy_kcal?.bestGuess).toBeDefined();
    expect(d.confidence.flags).toContain("core_nutrient_conflict");
    expect(d.confidence.overall).not.toBe("high");
  });

  it("counts copied labels once", () => {
    const v = { kcal: 735, fat: 82, sat: 55, carbs: 0.6, protein: 0.7, salt: 0.05 };
    const d = decide([label("labellevie", v, { copiedFrom: "off" }), label("off", v)]);
    expect(d.confidence.independentSources).toBe(1);
    expect(d.confidence.flags).toContain("copied_label_collapsed");
    expect(d.nutrients.fat_g?.agreement).toBe("single");
  });

  it("fills gaps from other sources (Tomme)", () => {
    const d = decide([
      label("labellevie", { fat: 29.4, sat: 18.5, carbs: 1.8, protein: 21.1, salt: 1.2 }),
      label("naturalia", {
        kcal: 352,
        fat: 29.4,
        sat: 18.5,
        carbs: 1.8,
        sugars: 0.5,
        protein: 21.1,
        salt: 1.2,
      }),
    ]);
    expect(d.nutrients.energy_kcal).toMatchObject({ value: 352, agreement: "single" });
    expect(d.nutrients.fat_g?.agreement).toBe("strong");
  });

  it("returns medium confidence for one consistent source", () => {
    const d = decide([label("kazidomi", { kcal: 42, fat: 0.8, carbs: 7.7, protein: 0.7, salt: 0.09 })]);
    expect(d.confidence.overall).toBe("medium");
    expect(d.confidence.flags).toContain("single_source");
  });

  it("returns none without any label", () => {
    const d = decide([]);
    expect(d.confidence.overall).toBe("none");
    expect(d.advice).toMatch(/No nutrition label/);
  });
});
