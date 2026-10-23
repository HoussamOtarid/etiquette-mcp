import { parseNumber, parseNutrientAmount } from "../domain/numbers.ts";
import type { NutrientKey } from "../domain/nutrients.ts";
import type { Basis, ExtraNutrient, NutrientValue } from "../domain/types.ts";

export interface ParsedTextLabel {
  basis: Basis;
  values: Partial<Record<NutrientKey, NutrientValue>>;
  sodiumG?: number;
  extra: ExtraNutrient[];
  citesOpenFoodFacts: boolean;
}

/** A value: optional comparator, a number (French decimals, thousands spaces), "traces", or "?". */
const NUMBER = String.raw`\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const AMOUNT = String.raw`((?:[<>]\s*)?(?:${NUMBER})|traces?|\?)`;
/** Separator between a label and its value: unit in brackets, colon, dash. */
const SEP = String.raw`\s*(?:\((?:g|mg|kj|kcal)\))?\s*[:\-–]?\s*`;

const MASS_PATTERNS: Array<[NutrientKey, RegExp]> = [
  [
    "saturated_fat_g",
    new RegExp(
      String.raw`(?:acides?\s+gras\s+satur[ée]s?|graisses\s+satur[ée]es|satur[ée]s)${SEP}${AMOUNT}`,
      "i",
    ),
  ],
  ["fat_g", new RegExp(String.raw`(?:mati[eè]res?\s+grasses?|graisses|lipides)${SEP}${AMOUNT}`, "i")],
  ["sugars_g", new RegExp(String.raw`(?:dont\s+)?sucres?${SEP}${AMOUNT}`, "i")],
  ["carbohydrates_g", new RegExp(`glucides${SEP}${AMOUNT}`, "i")],
  ["fiber_g", new RegExp(String.raw`fibres?(?:\s+alimentaires)?${SEP}${AMOUNT}`, "i")],
  ["protein_g", new RegExp(`prot[ée]ines?${SEP}${AMOUNT}`, "i")],
  ["salt_g", new RegExp(String.raw`\bsel${SEP}${AMOUNT}`, "i")],
];

const KNOWN_LABELS =
  /mati[eè]res?\s+grasses?|graisses|lipides|(?<!in)satur|sucres?|glucides|fibres?|prot[ée]ines?|\bsel\b|sodium|[ée]nergi|calories|valeurs?|tableau|\bpour\b|portion/i;

function detectBasis(text: string): Basis {
  const t = text.toLowerCase();
  const g = /100\s*g\b/.test(t);
  const ml = /100\s*ml\b|100\s*g\s*\/\s*ml|\/\s*100\s*ml/.test(t);
  if (g && ml) return "100g/100ml";
  if (ml) return "100ml";
  if (g) return "100g";
  return "unknown";
}

function parseEnergy(text: string): { kj?: number; kcal?: number } {
  const n = `(${NUMBER})`;
  // "Energie (kj)/(kcal):54/13"
  const pair = new RegExp(String.raw`\(kj\)\s*/\s*\(kcal\)\s*:?\s*${n}\s*/\s*${n}`, "i").exec(text);
  if (pair) return { kj: parseNumber(pair[1]) ?? undefined, kcal: parseNumber(pair[2]) ?? undefined };
  // "Energie (kJ) : 3700" / "Energie (kcal) : 900"
  const kjLabelled = new RegExp(String.raw`\(kj\)\s*:?\s*${n}`, "i").exec(text);
  const kcalLabelled = new RegExp(String.raw`\(kcal\)\s*:?\s*${n}`, "i").exec(text);
  // "182 kJ/43kcal", "1906 kJ | 455 kcal", "1 121 kj (268 kcal)", "743kcal"
  const kjInline = new RegExp(String.raw`${n}\s*kj\b`, "i").exec(text);
  const kcalInline = new RegExp(String.raw`${n}\s*kcal\b`, "i").exec(text);
  const kj = parseNumber(kjLabelled?.[1] ?? kjInline?.[1]);
  const kcal = parseNumber(kcalLabelled?.[1] ?? kcalInline?.[1]);
  return { kj: kj ?? undefined, kcal: kcal ?? undefined };
}

function parseSodium(text: string): number | undefined {
  const m = /sodium\s*:?\s*(\d+(?:[.,]\d+)?)\s*(mg|g)\b/i.exec(text);
  if (!m?.[1]) return undefined;
  const value = parseNumber(m[1]);
  if (value === null) return undefined;
  return m[2]?.toLowerCase() === "mg" ? value / 1000 : value;
}

function parseExtras(text: string): ExtraNutrient[] {
  const out: ExtraNutrient[] = [];
  const re =
    /([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{2,40}?)\s*(?:-\s*[A-Za-zÀ-ÿ]+\s*)?:?\s*(\d+(?:[.,]\d+)?)\s*(mg|µg|mcg|g)\b/g;
  for (const m of text.matchAll(re)) {
    const name = (m[1] ?? "").trim().replace(/^(?:dont|et)\s+/i, "");
    if (!name || KNOWN_LABELS.test(name)) continue;
    out.push({ name, value: parseNumber(m[2]), unit: m[3] ?? null, raw: m[0].trim() });
  }
  return out;
}

/**
 * Parses a French nutrition label written as free text, as published by shops that paste the supplier's text:
 * "(Pour 100g) Energie : 182 kJ/43kcal, Matières grasses : 1 g dont acides gras saturés 0,7 g, …",
 * "Pour 100 g Valeurs énergetiques 1906 kJ | 455 kcal Matières grasses 19 g …", "Graisses (g) : 100", "Sel : Traces".
 */
export function parseTextLabel(input: string): ParsedTextLabel {
  const text = input.replace(/_{3,}/g, " ").replace(/\s+/g, " ").trim();
  const values: ParsedTextLabel["values"] = {};

  const { kj, kcal } = parseEnergy(text);
  if (kj !== undefined) values.energy_kj = { value: kj };
  if (kcal !== undefined) values.energy_kcal = { value: kcal };

  // Saturated fat is matched first and removed so that "acides gras" is not read as "matières grasses".
  let rest = text;
  for (const [key, pattern] of MASS_PATTERNS) {
    const m = pattern.exec(rest);
    if (!m?.[1]) continue;
    const amount = parseNutrientAmount(m[1]);
    if (amount) values[key] = amount;
    rest = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length);
  }

  return {
    basis: detectBasis(text),
    values,
    sodiumG: parseSodium(text),
    extra: parseExtras(text),
    citesOpenFoodFacts: /open\s*food\s*facts/i.test(text),
  };
}
