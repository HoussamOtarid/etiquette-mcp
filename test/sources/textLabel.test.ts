import { describe, expect, it } from "vitest";
import { parseTextLabel } from "../../src/sources/textLabel.ts";

const values = (text: string) =>
  Object.fromEntries(Object.entries(parseTextLabel(text).values).map(([k, v]) => [k, v?.value]));

describe("free-text label parser", () => {
  it("reads the colon format", () => {
    const text =
      "(Pour 100g) Energie : 182 kJ/43kcal, Matières grasses : 1 g dont acides gras saturés 0,7 g, Glucides : 4,7 g dont sucres 4,7 g, Fibres alimentaires : 0 g, Protéines : 3,8 g, Sel : 0,12 g.";
    expect(values(text)).toEqual({
      energy_kj: 182,
      energy_kcal: 43,
      fat_g: 1,
      saturated_fat_g: 0.7,
      carbohydrates_g: 4.7,
      sugars_g: 4.7,
      fiber_g: 0,
      protein_g: 3.8,
      salt_g: 0.12,
    });
    expect(parseTextLabel(text).basis).toBe("100g");
  });

  it("reads the pipe format with dot decimals", () => {
    const text =
      "Pour 100 g Valeurs énergetiques 1906 kJ | 455 kcal Matières grasses 19 g Acides gras saturés 4.9 g Glucides 57 g Dont sucres 16 g Fibres alimentaires 10 g Protéines 8.1 g Sel 0.48 g";
    expect(values(text)).toMatchObject({
      energy_kcal: 455,
      fat_g: 19,
      saturated_fat_g: 4.9,
      sugars_g: 16,
      salt_g: 0.48,
    });
  });

  it("reads thousands separators, brackets and extra rows", () => {
    const text =
      "Tableau nutritionnel pour 100 g / 100 ml Énergie 1 121 kj (268 kcal) Matières grasses 9,2 g Acides gras saturés 5 g Acides gras monoinsaturés 3,1 g Glucides 34 g Sucres 3,6 g Protéines 11 g Sel 1,3 g";
    const parsed = parseTextLabel(text);
    expect(values(text)).toMatchObject({
      energy_kj: 1121,
      energy_kcal: 268,
      fat_g: 9.2,
      saturated_fat_g: 5,
      protein_g: 11,
    });
    expect(parsed.basis).toBe("100g/100ml");
    expect(parsed.extra.map((e) => e.name)).toContain("Acides gras monoinsaturés");
  });

  it("reads units written before the value", () => {
    const text =
      "pour 100g : Energie (kJ) : 3700 Energie (kcal) : 900 Graisses (g) : 100 dont acides gras saturés (g) : 14 Glucides (g) : 0 dont sucres (g) : 0 Protéines (g) : 0 Sel (g) : 0";
    expect(values(text)).toMatchObject({
      energy_kj: 3700,
      energy_kcal: 900,
      fat_g: 100,
      saturated_fat_g: 14,
      salt_g: 0,
    });
  });

  it("reads dashes, traces and comparators", () => {
    expect(
      values(
        "Pour 100g ÉNERGIE - 743kcal MATIÈRES GRASSES - 82g GLUCIDES - 0,6g PROTÉINES - 0,7g SEL- 0,05g",
      ),
    ).toMatchObject({
      energy_kcal: 743,
      fat_g: 82,
      carbohydrates_g: 0.6,
      salt_g: 0.05,
    });
    const juice = parseTextLabel(
      "pour 100 ml Energie : 159 kJ / 38 kcal Matières grasses : Traces Sel : Traces",
    );
    expect(juice.values.fat_g).toEqual({ value: 0, qualifier: "traces" });
    expect(juice.basis).toBe("100ml");
    expect(parseTextLabel("Fibres alimentaires : <0,5 g").values.fiber_g).toEqual({
      value: 0.5,
      qualifier: "lt",
    });
  });

  it("converts sodium and detects copied labels", () => {
    const parsed = parseTextLabel(
      "Valeurs nutritionnelles pour 100g : Energie : 2357,52 kJ / 564 kcal Sodium : 780mg Source : Open Food Facts (ODbL)",
    );
    expect(parsed.sodiumG).toBe(0.78);
    expect(parsed.citesOpenFoodFacts).toBe(true);
  });

  it("reads energy-only labels", () => {
    expect(values("Energie (kj)/(kcal):54/13")).toEqual({ energy_kj: 54, energy_kcal: 13 });
  });

  it("does not invent missing values", () => {
    expect(values("Fibres alimentaires ? Protéines 3,5 g")).toEqual({ protein_g: 3.5 });
  });
});
