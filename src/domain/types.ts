import type { NutrientKey } from "./nutrients.ts";

export const SOURCE_IDS = [
  "off",
  "lafourche",
  "kazidomi",
  "biocoop",
  "lavieclaire",
  "naturalia",
  "labellevie",
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

/**
 * Data-quality tier of a source:
 * A = structured data through an API, B = structured product page, C = free-text label on the page.
 */
export type Tier = "A" | "B" | "C";

/** "100g/100ml" means the source states both; it is treated as comparable with either. */
export type Basis = "100g" | "100ml" | "100g/100ml" | "unknown";

export interface NutrientValue {
  value: number;
  /** Label said "< 0.5" or "traces"; `value` is then the bound (or 0 for traces). */
  qualifier?: "lt" | "gt" | "traces";
}

/** A nutrient line present on a label that does not map to a canonical key (vitamins, minerals, polyols, ...). */
export interface ExtraNutrient {
  name: string;
  value: number | null;
  unit: string | null;
  raw: string;
}

export type ParseStatus = "ok" | "partial" | "empty";

/** One source's label for one product, before any cross-source decision. */
export interface SourceLabel {
  source: SourceId;
  basis: Basis;
  /** The basis was not on the label and was inferred from the pack unit. */
  basisInferred?: boolean;
  values: Partial<Record<NutrientKey, NutrientValue>>;
  /** Sodium in grams per 100 g/ml, when the label gives sodium. */
  sodiumG?: number;
  extra: ExtraNutrient[];
  /** The label exactly as published, when it is free text or a table that can be serialised to text. */
  raw: string | null;
  ingredients: string | null;
  /** Language of the ingredients text, when known (shops publish French). */
  ingredientsLang?: string;
  allergens: string | null;
  traces: string | null;
  nutriscore: string | null;
  /** For Open Food Facts: who supplied the data ("producer" feed or "crowd" contributions). */
  dataOrigin?: "producer" | "crowd" | "store";
  /** The label itself says it was copied from another source (e.g. "Source : Open Food Facts"). */
  copiedFrom?: SourceId;
  /** The source stores unknown values as 0 (Kazidomi); zeros must not be trusted blindly. */
  zeroMeansUnknown?: boolean;
  parseStatus: ParseStatus;
  url: string | null;
  fetchedAt: string;
  /** When the source last changed this product's data, if the source says. */
  updatedAt?: string;
}

/** A product as listed by one source (search result). */
export interface Offer {
  source: SourceId;
  /** Source-specific identifier used to fetch the label later (URL, numeric id, ...). */
  sourceProductId: string;
  url: string | null;
  name: string;
  brand: string | null;
  ean: string | null;
  sizeText: string | null;
  priceEur: number | null;
  unitPriceText: string | null;
  inStock: boolean | null;
  /** Some sources return the label inside search results (La Fourche, Open Food Facts). */
  label?: SourceLabel;
}
