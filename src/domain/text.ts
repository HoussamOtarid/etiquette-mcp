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

/** Lowercase, strip accents and punctuation, collapse spaces. Ligatures are spelled out (bœuf → boeuf). */
export function normalizeText(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/[œŒ]/g, "oe")
    .replace(/[æÆ]/g, "ae")
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

/** Stemming dominates matching time and the same names come back often (shop listings, the Ciqual table). */
const tokenCache = new Map<string, Token[]>();
const TOKEN_CACHE_SIZE = 20_000;

function tokensOf(text: string | null | undefined): Token[] {
  const key = text ?? "";
  let tokens = tokenCache.get(key);
  if (!tokens) {
    const seen = new Set<string>();
    tokens = nameTokens(key)
      .map((raw) => ({ raw, stem: frenchStemmer.stem(raw) }))
      .filter((t) => !seen.has(t.stem) && seen.add(t.stem));
    if (tokenCache.size >= TOKEN_CACHE_SIZE) tokenCache.clear();
    tokenCache.set(key, tokens);
  }
  return [...tokens];
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

/** Every word of one name is in the other ("Kéfir citron" ⊂ "Kéfir frais citron"), as opposed to a word swap. */
export function oneNameContainsTheOther(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  const within = (x: Token[], y: Token[]) => x.every((t) => y.some((u) => sameToken(t, u)));
  return within(ta, tb) || within(tb, ta);
}

/**
 * How well a text covers a query: query words found in the text (by stem or a one-letter typo), how many of those are
 * written the same ("pâtes", not "pâte"), out of all query words, and the text's other words.
 */
export function wordMatch(
  query: string | null | undefined,
  text: string | null | undefined,
): { found: number; exact: number; wanted: number; extra: number } {
  const wanted = tokensOf(query);
  const unmatched = tokensOf(text);
  const total = unmatched.length;
  let found = 0;
  let exact = 0;
  for (const token of wanted) {
    const i = unmatched.findIndex((other) => sameToken(token, other));
    if (i < 0) continue;
    found++;
    if (unmatched[i]?.raw === token.raw) exact++;
    unmatched.splice(i, 1);
  }
  return { found, exact, wanted: wanted.length, extra: total - found };
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

/**
 * A brand written in the query ("bonval bœuf haché"): the longest of the given brands whose words all appear in the
 * query. Brands made only of short or generic words are ignored.
 */
export function brandInQuery(query: string, brands: Array<string | null>): string | null {
  const words = new Set(normalizeText(query).split(" "));
  let best: string | null = null;
  for (const brand of brands) {
    const parts = brandSlug(brand).split("-").filter(Boolean);
    if (parts.length === 0 || !parts.some((w) => w.length >= 3 && !STOPWORDS.has(w))) continue;
    if (parts.every((w) => words.has(w)) && (!best || brandSlug(brand).length > brandSlug(best).length))
      best = brand;
  }
  return best;
}

/** The texts share at least one word, not counting the brand's words. */
export function sharesWordBesidesBrand(
  query: string,
  text: string,
  brand: string | null | undefined,
): boolean {
  const brandTokens = tokensOf(brand);
  const queryTokens = tokensOf(query).filter((t) => !brandTokens.some((b) => sameToken(t, b)));
  const textTokens = tokensOf(text);
  return queryTokens.some((q) => textTokens.some((t) => sameToken(q, t)));
}

/** Percentages written in a text ("5%", "20 %MG", "4,5 %"), as numbers. */
export function percentagesOf(text: string | null | undefined): number[] {
  return [...(text ?? "").matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((m) =>
    Number((m[1] ?? "").replace(",", ".")),
  );
}
