/** Canonical nutrient keys. Values are always expressed per 100 g or per 100 ml (see `Basis`). */
export const NUTRIENT_KEYS = [
  "energy_kj",
  "energy_kcal",
  "fat_g",
  "saturated_fat_g",
  "carbohydrates_g",
  "sugars_g",
  "fiber_g",
  "protein_g",
  "salt_g",
] as const;

export type NutrientKey = (typeof NUTRIENT_KEYS)[number];

/** Nutrients without which a label is not usable for calorie/macro tracking. */
export const CORE_NUTRIENTS: readonly NutrientKey[] = [
  "energy_kcal",
  "fat_g",
  "carbohydrates_g",
  "protein_g",
];

/** Nutrients measured in grams (everything except energy). */
export const MASS_NUTRIENTS: readonly NutrientKey[] = NUTRIENT_KEYS.filter((k) => k.endsWith("_g"));

export const NUTRIENT_LABELS_FR: Record<NutrientKey, string> = {
  energy_kj: "Énergie (kJ)",
  energy_kcal: "Énergie (kcal)",
  fat_g: "Matières grasses",
  saturated_fat_g: "dont acides gras saturés",
  carbohydrates_g: "Glucides",
  sugars_g: "dont sucres",
  fiber_g: "Fibres alimentaires",
  protein_g: "Protéines",
  salt_g: "Sel",
};

/** 1 kcal = 4.184 kJ. */
export const KJ_PER_KCAL = 4.184;

/** Salt is labelled as sodium × 2.5 under EU rules (Regulation 1169/2011, Annex I). */
export const SALT_PER_SODIUM = 2.5;

export function isNutrientKey(value: string): value is NutrientKey {
  return (NUTRIENT_KEYS as readonly string[]).includes(value);
}
