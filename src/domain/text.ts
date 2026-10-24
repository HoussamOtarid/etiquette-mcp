import { distance } from "fastest-levenshtein";
import snowball from "snowball-stemmers";

const STOPWORDS = new Set([
  "a",
  "au",
  "aux",
  "avec",
  "bio",
  "biologique",
  "de",
  "des",
  "du",
  "en",
  "et",
  "la",
  "le",
  "les",
  "pour",
  "sans",
  "sur",
  "un",
  "une",
  "x",
]);

/** Lowercase, strip accents and punctuation, collapse spaces. */
export function normalizeText(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Meaningful word tokens of a product name: quantities, percentages and stopwords removed. */
export function nameTokens(text: string | null | undefined): string[] {
  const cleaned = normalizeText(text)
    .replace(/\b\d+(?: \d+)?\s*(?:kg|gr|g|ml|cl|dl|l)\b/g, " ")
    .replace(/\b\d+\b/g, " ");
  return cleaned.split(" ").filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

const frenchStemmer = snowball.newStemmer("french");
const TYPO_MIN_LENGTH = 5;

interface Token {
  raw: string;
  stem: string;
}

function tokensOf(text: string | null | undefined): Token[] {
  const seen = new Set<string>();
  return nameTokens(text)
    .map((raw) => ({ raw, stem: frenchStemmer.stem(raw) }))
    .filter((t) => !seen.has(t.stem) && seen.add(t.stem));
}

/** Same word: same stem (plural, gender), or the written words are one edit apart (typo). */
function sameToken(a: Token, b: Token): boolean {
  if (a.stem === b.stem) return true;
  return a.raw.length >= TYPO_MIN_LENGTH && b.raw.length >= TYPO_MIN_LENGTH && distance(a.raw, b.raw) <= 1;
}

/**
 * Similarity of two product names, 0..1: Jaccard index over tokens matched by stem or by a one-letter typo
 * ("complets" / "complètes", "musli" / "muesli"). Word order does not matter.
 */
export function tokenSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const unmatched = [...tb];
  let shared = 0;
  for (const token of ta) {
    const i = unmatched.findIndex((other) => sameToken(token, other));
    if (i >= 0) {
      shared++;
      unmatched.splice(i, 1);
    }
  }
  return shared / (ta.length + tb.length - shared);
}

/** Open Food Facts style tag: "Prix Mini" → "prix-mini", "Côteaux Nantais" → "coteaux-nantais". */
export function brandSlug(brand: string | null | undefined): string {
  return normalizeText(brand).replace(/ /g, "-");
}

/** Brands are equal when their slugs match or one contains the other ("U" vs "U Bio" is handled by containment). */
export function sameBrand(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const sa = brandSlug(a);
  const sb = brandSlug(b);
  if (!sa || !sb) return null;
  if (sa === sb) return true;
  const wa = sa.split("-");
  const wb = sb.split("-");
  return wa.every((w) => wb.includes(w)) || wb.every((w) => wa.includes(w));
}
