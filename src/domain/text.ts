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
    .replace(/[̀-ͯ]/g, "")
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

/** Jaccard similarity of two token sets, 0..1. */
export function tokenSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared++;
  return shared / (ta.size + tb.size - shared);
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
