import type { Config } from "../config.ts";
import type { Offer, SourceId, SourceLabel, Tier } from "../domain/types.ts";
import type { Cache } from "../infra/cache.ts";
import type { HttpClient } from "../infra/http.ts";
import type { Logger } from "../infra/logger.ts";

export interface SearchQuery {
  /** Free text: product name and/or keywords. */
  text?: string;
  /** Canonical EAN-13 / GTIN. */
  ean?: string;
  brand?: string;
  limit: number;
}

export interface LabelResult {
  label: SourceLabel | null;
  /** Some sources only reveal the barcode on the product page. */
  ean?: string | null;
}

export interface SourceAdapter {
  readonly id: SourceId;
  readonly tier: Tier;
  readonly displayName: string;
  readonly capabilities: {
    /** Can search by free text. */
    text: boolean;
    /** Can look a barcode up directly. */
    ean: boolean;
  };
  search(query: SearchQuery): Promise<Offer[]>;
  /** Fetches the label for an offer returned by `search` (may be served from `offer.label`). */
  getLabel(offer: Offer): Promise<LabelResult>;
}

export interface AdapterDeps {
  http: HttpClient;
  cache: Cache;
  logger: Logger;
  config: Config;
}

/** Empty label skeleton shared by all adapters. */
export function emptyLabel(source: SourceId, url: string | null): SourceLabel {
  return {
    source,
    basis: "unknown",
    values: {},
    extra: [],
    raw: null,
    ingredients: null,
    allergens: null,
    traces: null,
    nutriscore: null,
    parseStatus: "empty",
    url,
    fetchedAt: new Date().toISOString(),
  };
}

/** Marks the parse status from the number of nutrients found. */
export function finalizeLabel(label: SourceLabel): SourceLabel {
  const count = Object.keys(label.values).length + (label.sodiumG !== undefined ? 1 : 0);
  label.parseStatus = count === 0 ? "empty" : count >= 6 ? "ok" : "partial";
  return label;
}

export function cleanText(text: string | null | undefined): string | null {
  const t = (text ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 0 ? t : null;
}
