import { normalizeText } from "../domain/text.ts";

export const TAXONOMY_URL = "https://static.openfoodfacts.org/data/taxonomies/categories.json";

/** Names of each category (French and English, normalised) and its parents, from Open Food Facts' taxonomy. */
export type CategoryTaxonomy = Map<string, { names: string; parents: string[] }>;

interface TaxonomyEntry {
  name?: Record<string, string>;
  parents?: string[];
}

export function parseCategoryTaxonomy(json: Record<string, TaxonomyEntry>): CategoryTaxonomy {
  const taxonomy: CategoryTaxonomy = new Map();
  for (const [tag, entry] of Object.entries(json)) {
    const names = [...new Set([entry.name?.fr, entry.name?.en].map((n) => normalizeText(n)).filter(Boolean))];
    taxonomy.set(tag, { names: names.join(" "), parents: entry.parents ?? [] });
  }
  return taxonomy;
}

/** A tag outside the taxonomy ("fr:sorbet-citron") read as words. */
const tagWords = (tag: string) => normalizeText(tag.replace(/^[a-z]{2}:/, "").replace(/-/g, " "));

/**
 * Words naming what a product is, from its most specific categories only ("Sorbets au citron", not "Desserts"):
 * the tags that are not a parent of another of its tags.
 */
export function categoryText(tags: string[] | undefined, taxonomy: CategoryTaxonomy): string {
  if (!tags?.length) return "";
  const parents = new Set(tags.flatMap((t) => taxonomy.get(t)?.parents ?? []));
  const leaves = tags.filter((t) => !parents.has(t));
  return [...new Set(leaves.map((t) => taxonomy.get(t)?.names || tagWords(t)).filter(Boolean))].join(" ");
}
