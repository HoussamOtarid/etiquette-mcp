import type { NutrientKey } from "../domain/nutrients.ts";
import { nameTokens, percentagesOf, wordMatch } from "../domain/text.ts";

/** Ciqual on recherche.data.gouv.fr: the French food composition table, by ANSES. */
export const CIQUAL_DOI = "10.57745/RDMHWY";

export interface CiqualValue {
  v: number;
  q?: "lt" | "traces";
  /** Ciqual confidence code, A (most reliable) to D. */
  c?: string;
}

export interface CiqualFood {
  code: number;
  name: string;
  name_en: string;
  group: string | null;
  values: Partial<Record<NutrientKey, CiqualValue>>;
}

export interface CiqualData {
  /** Publication date of the table version. */
  version: string;
  doi: string;
  foods: CiqualFood[];
}

export interface CiqualMatch {
  food: CiqualFood;
  score: number;
}

const AVERAGE = /\s*\(aliment moyen\)|\s*\(average\)/i;

/** Relevance of one name to the query (about 0..1; above 1 for the closest names). */
function nameScore(query: string, fullName: string): number {
  // "(aliment moyen)": the average of several entries, a good default; not words to match.
  const name = fullName.replace(AVERAGE, "");
  const all = wordMatch(query, name);
  if (all.wanted === 0 || all.found === 0) return 0;
  // Ciqual names read "Food, details": the food is named first, as in most queries.
  const first = wordMatch(nameTokens(query)[0], nameTokens(name)[0]).found === 1;
  const head = wordMatch(name.split(",")[0], query);
  const wanted = percentagesOf(query);
  const stated = percentagesOf(name);
  const percent =
    wanted.length === 0 ? 0 : wanted.some((p) => stated.includes(p)) ? 0.1 : stated.length > 0 ? -0.2 : -0.05;
  return (
    (0.75 * all.found) / all.wanted +
    (0.1 * all.exact) / all.wanted +
    (first ? 0.1 : 0) +
    (head.found === head.wanted ? 0.05 : 0) +
    (name !== fullName ? 0.05 : 0) +
    percent -
    Math.min(0.15, 0.015 * all.extra)
  );
}

/** Foods of the Ciqual table matching a query in French or English, best first; scores shown on a 0–1 scale. */
export function searchCiqual(foods: CiqualFood[], query: string, limit: number): CiqualMatch[] {
  return foods
    .map((food) => ({ food, raw: Math.max(nameScore(query, food.name), nameScore(query, food.name_en)) }))
    .filter((m) => m.raw > 0)
    .sort((a, b) => b.raw - a.raw || a.food.name.length - b.food.name.length)
    .slice(0, limit)
    .map(({ food, raw }) => ({ food, score: Math.round(Math.min(1, raw) * 1000) / 1000 }));
}
