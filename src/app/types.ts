import type { NutrientKey } from "../domain/nutrients.ts";
import type { Basis, SourceId } from "../domain/types.ts";
import type { MatchKind } from "../engine/identity.ts";
import type { Agreement, Confidence, Flag } from "../engine/types.ts";

/** Outcome of calling one source during a request. */
/** "skipped": not called for this request (not needed, or answered from the cache). */
export type SourceStatus =
  | "ok"
  | "not_found"
  | "timeout"
  | "rate_limited"
  | "error"
  | "not_supported"
  | "skipped";

export type Qualifier = "lt" | "gt" | "traces";

export interface OfferView {
  source: SourceId;
  name: string;
  brand: string | null;
  url: string | null;
  price_eur: number | null;
  in_stock: boolean | null;
}

export interface PackSize {
  amount: number;
  unit: "g" | "ml";
}

/** Main macros from a label already at hand (no extra request), to tell candidates apart. */
export interface LabelPreview {
  source: SourceId;
  basis: Basis;
  energy_kcal: number | null;
  protein_g: number | null;
  carbohydrates_g: number | null;
  fat_g: number | null;
}

export interface ProductView {
  product_ref: string;
  ean: string | null;
  name: string;
  brand: string | null;
  size: string | null;
  pack: PackSize | null;
  /** How offers were grouped: same barcode, or brand + size + name. */
  match: MatchKind;
  /** Relevance to the query (text searches only). */
  score?: number;
  label_preview?: LabelPreview;
  /** Stores selling it with price and link (left out in compact results, which give `stores` instead). */
  offers?: OfferView[];
  stores?: SourceId[];
}

/** Hints about how well text-search results match the query. */
export interface MatchHints {
  /** The best product scores below 0.5: probably not what was asked for. */
  no_good_match?: true;
  /** The `brand` given matched no product: results are other brands. */
  requested_brand_found?: false;
}

export interface FindProductResult extends MatchHints {
  query_kind: "barcode" | "text";
  products: ProductView[];
  sources: Partial<Record<SourceId, SourceStatus>>;
  notes: string[];
}

export interface NutrientView {
  value: number | null;
  agreement: Agreement;
  /** Left out in compact results. */
  sources_agree?: number;
  sources_total?: number;
  supporting?: SourceId[];
  qualifier?: Qualifier;
  dissent?: Array<{ source: SourceId; value: number }>;
  best_guess?: number;
}

export interface PerSourceView {
  source: SourceId;
  url: string | null;
  fetched_at: string;
  last_updated: string | null;
  basis: Basis;
  structured: Partial<Record<NutrientKey, number>>;
  raw_label: string | null;
  extra_nutrients: Array<{ name: string; value: number | null; unit: string | null; raw: string }>;
  self_check: {
    status: "pass" | "fail" | "insufficient";
    kcal_stated: number | null;
    kcal_from_macros: number | null;
  };
  flags: Flag[];
  notes: string[];
  data_origin: string | null;
}

export type FlatValues = Partial<Record<NutrientKey | "sodium_g", number | null>>;

/** The decided label as flat numbers, ready to store: per 100 g/ml, and per pack when the pack size is known. */
export interface ReadyToApply {
  basis: Basis;
  /** null for a nutrient the sources disagree on (see conflicts). */
  per_100: FlatValues;
  qualifiers: Partial<Record<NutrientKey, Qualifier>>;
  pack: PackSize | null;
  per_pack: FlatValues | null;
  /** Nutrients left null because sources disagree, with each source's value and the most trusted one. */
  conflicts?: Array<{
    nutrient: NutrientKey;
    values: Array<{ source: SourceId; value: number }>;
    best_guess: number | null;
  }>;
}

export interface GetLabelResult extends MatchHints {
  /** "incomplete": some sources did not answer, so an empty or partial result is not final (see retry_after_s). */
  status: "found" | "ambiguous" | "not_found" | "incomplete";
  retry_after_s?: number;
  product: ProductView | null;
  label: {
    basis: Basis;
    nutrients: Partial<Record<NutrientKey, NutrientView>>;
    nutriscore: { value: string; sources: SourceId[] } | null;
  } | null;
  ready_to_apply?: ReadyToApply;
  confidence: {
    overall: Confidence;
    sources_with_label: number;
    independent_sources: number;
    missing_nutrients: NutrientKey[];
    self_check: { passed: SourceId[]; failed: SourceId[]; insufficient: SourceId[] };
    flags: Flag[];
    flag_details: Array<{ flag: string; source: SourceId; nutrient?: NutrientKey; detail?: string }>;
  } | null;
  advice: string;
  ingredients?: { text: string; source: SourceId; lang: string | null } | null;
  allergens?: { text: string; source: SourceId } | null;
  traces?: { text: string; source: SourceId } | null;
  offers?: OfferView[];
  per_source?: PerSourceView[];
  /** Top matches when the query does not designate a single product. */
  candidates?: ProductView[];
  /** Same brand, similar name: other sizes or flavours of the product. */
  variants?: ProductView[];
  /** Other products (other brands) when the requested product has no label anywhere. */
  similar_products?: ProductView[];
  sources: Partial<Record<SourceId, SourceStatus>>;
  notes: string[];
}

export interface GetLabelsResult {
  results: Array<{ input: string } & GetLabelResult>;
}

export interface PriceView {
  source: SourceId;
  name: string;
  brand: string | null;
  url: string | null;
  price_eur: number;
  in_stock: boolean | null;
}

export interface ComparePricesResult extends MatchHints {
  status: "found" | "ambiguous" | "not_found" | "incomplete";
  retry_after_s?: number;
  product: ProductView | null;
  /** Every store selling the product, cheapest total price first. */
  offers?: PriceView[];
  cheapest?: PriceView | null;
  spread?: { cheapest: number; most_expensive: number; savings_pct: number } | null;
  candidates?: ProductView[];
  sources: Partial<Record<SourceId, SourceStatus>>;
  notes: string[];
}

export interface SourceInfo {
  source: SourceId;
  name: string;
  tier: string;
  search_by_text: boolean;
  search_by_barcode: boolean;
  status: "ok" | "degraded" | "unknown";
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure: string | null;
  calls_24h: number;
  failures_24h: number;
  p50_ms: number | null;
}
