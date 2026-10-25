import table from "../data/ciqual.json" with { type: "json" };
import { type NutrientKey, SALT_PER_SODIUM } from "../domain/nutrients.ts";
import { CIQUAL_DOI, type CiqualData, type CiqualFood, searchCiqual } from "../sources/ciqual.ts";
import { displayValue } from "./present.ts";
import type { FlatValues, GenericFoodResult, GenericFoodView } from "./types.ts";

const CIQUAL = table as CiqualData;
const QUALITY_NUTRIENTS: NutrientKey[] = ["fat_g", "carbohydrates_g", "protein_g"];
export const DEFAULT_GENERIC_FOODS = 5;

export const CIQUAL_SOURCE = {
  name: "Ciqual, French food composition table (ANSES)",
  version: CIQUAL.version,
  licence: "Licence Ouverte / Etalab 2.0",
  url: `https://doi.org/${CIQUAL_DOI}`,
} as const;

const ADVICE =
  "Average composition of this kind of food from the Ciqual table, not the label of a specific product: prefer " +
  "get_label for packaged products. Values are per 100 g, also for drinks. Pick the entry matching how the food " +
  "was prepared (raw, cooked, dried…).";
const NO_MATCH_ADVICE = "No food of the Ciqual table matches this query. Try a simpler food name, in French.";

function foodView(food: CiqualFood, score: number): GenericFoodView {
  const per100: FlatValues = {};
  const qualifiers: GenericFoodView["qualifiers"] = {};
  for (const [key, value] of Object.entries(food.values) as Array<
    [NutrientKey, CiqualFood["values"][NutrientKey]]
  >) {
    if (!value) continue;
    per100[key] = displayValue(key, value.v);
    if (value.q) qualifiers[key] = value.q;
  }
  const salt = food.values.salt_g?.v;
  if (salt !== undefined) per100.sodium_g = displayValue("sodium_g", salt / SALT_PER_SODIUM);
  const codes = QUALITY_NUTRIENTS.map((k) => food.values[k]?.c).filter((c): c is string => Boolean(c));
  return {
    ciqual_code: food.code,
    name: food.name,
    name_en: food.name_en,
    group: food.group,
    score,
    basis: "100g",
    per_100: per100,
    qualifiers,
    data_quality: codes.length > 0 ? ([...codes].sort().at(-1) ?? null) : null,
  };
}

/** Generic foods (fruit, vegetables, meat, staples…) from the Ciqual table, best match first. */
export function genericFoods(query: string, limit = DEFAULT_GENERIC_FOODS): GenericFoodResult {
  const foods = searchCiqual(CIQUAL.foods, query, limit).map((m) => foodView(m.food, m.score));
  return { foods, source: CIQUAL_SOURCE, advice: foods.length > 0 ? ADVICE : NO_MATCH_ADVICE };
}

export function genericFoodsInfo(): { source: string; version: string; foods: number } {
  return { source: CIQUAL_SOURCE.name, version: CIQUAL.version, foods: CIQUAL.foods.length };
}
