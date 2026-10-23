import type { NutrientKey } from "../domain/nutrients.ts";
import type { Basis, SourceId } from "../domain/types.ts";
import type { MatchKind } from "../engine/identity.ts";
import type { Agreement, Confidence, Flag } from "../engine/types.ts";

/** Outcome of calling one source during a request. */
export type SourceStatus = "ok" | "not_found" | "timeout" | "rate_limited" | "error" | "not_supported";

export interface OfferView {
  source: SourceId;
  name: string;
  brand: string | null;
  url: string | null;
  price_eur: number | null;
  unit_price: string | null;
  in_stock: boolean | null;
}

export interface ProductView {
  product_ref: string;
  ean: string | null;
  name: string;
  brand: string | null;
  size: string | null;
  /** How offers were grouped: same barcode, or brand + size + name. */
  match: MatchKind;
  offers: OfferView[];
}

export interface FindProductResult {
  query_kind: "barcode" | "text";
  products: ProductView[];
  sources: Partial<Record<SourceId, SourceStatus>>;
  notes: string[];
}

export interface NutrientView {
  value: number | null;
  agreement: Agreement;
  sources_agree: number;
  sources_total: number;
  supporting: SourceId[];
  qualifier?: "lt" | "gt" | "traces";
  dissent?: Array<{ source: SourceId; value: number }>;
  best_guess?: number;
}

export interface PerSourceView {
  source: SourceId;
  url: string | null;
  fetched_at: string;
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

export interface GetLabelResult {
  status: "found" | "ambiguous" | "not_found";
  product: ProductView | null;
  label: {
    basis: Basis;
    nutrients: Partial<Record<NutrientKey, NutrientView>>;
    nutriscore: { value: string; sources: SourceId[] } | null;
  } | null;
  confidence: {
    overall: Confidence;
    sources_with_label: number;
    independent_sources: number;
    missing_nutrients: NutrientKey[];
    self_check: { passed: SourceId[]; failed: SourceId[]; insufficient: SourceId[] };
    flags: Flag[];
  } | null;
  advice: string;
  ingredients: { text: string; source: SourceId } | null;
  allergens: { text: string; source: SourceId } | null;
  traces: { text: string; source: SourceId } | null;
  offers: OfferView[];
  per_source?: PerSourceView[];
  /** Top matches when the query does not designate a single product. */
  candidates?: ProductView[];
  /** Other products (other brands) when the requested product has no label anywhere. */
  similar_products?: ProductView[];
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
