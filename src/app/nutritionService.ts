import type { Config } from "../config.ts";
import { looksLikeBarcode, normalizeEan } from "../domain/ean.ts";
import { parseQuantity } from "../domain/quantity.ts";
import {
  brandInQuery,
  nameTokens,
  sameBrand,
  sharesWordBesidesBrand,
  tokenSimilarity,
} from "../domain/text.ts";
import type { Offer, SourceId, SourceLabel, Tier } from "../domain/types.ts";
import { decideLabel } from "../engine/decide.ts";
import { groupOffers, isUnambiguous, type ProductGroup, rankGroups } from "../engine/identity.ts";
import type { Cache } from "../infra/cache.ts";
import type { HealthTracker } from "../infra/health.ts";
import type { Logger } from "../infra/logger.ts";
import type { SourceAdapter } from "../sources/adapter.ts";
import { compareWithLabel, type ExpectedValues, previewVerdict } from "./compare.ts";
import {
  compactLabelResult,
  labelPreview,
  labelSection,
  offerView,
  perSourceViews,
  priceView,
  productView,
  readyToApply,
} from "./present.ts";
import { rankByPrice, spreadOf } from "./prices.ts";
import { callSource, mergeStatus } from "./sourceCall.ts";
import type {
  ComparePricesResult,
  FindProductResult,
  GetLabelResult,
  GetLabelsResult,
  MatchHints,
  SourceInfo,
  SourceStatus,
} from "./types.ts";

export interface FindProductInput {
  query: string;
  brand?: string;
  size?: string;
  sources?: SourceId[];
  limit?: number;
}

export interface GetLabelInput {
  product: string;
  brand?: string;
  sources?: SourceId[];
  includeRaw?: boolean;
  compareTo?: ExpectedValues;
  /** Leave out offers, per-source labels, ingredients, variants and similar products. */
  compact?: boolean;
}

export interface BatchItem {
  product: string;
  brand?: string;
  compareTo?: ExpectedValues;
}

export interface GetLabelsInput {
  products: Array<string | BatchItem>;
  sources?: SourceId[];
  includeRaw?: boolean;
  /** Default true. */
  compact?: boolean;
}

export interface ComparePricesInput {
  product: string;
  brand?: string;
  sources?: SourceId[];
}

type RankedGroup = ProductGroup & { score: number; contradicted: boolean };

type Resolution =
  | { kind: "group"; group: ProductGroup; ranked: RankedGroup[] }
  | { kind: "ambiguous"; ranked: RankedGroup[] }
  | { kind: "none"; advice: string };

interface Statuses {
  sources: Partial<Record<SourceId, SourceStatus>>;
  notes: string[];
  /** Score of the best text-search result. */
  topScore?: number;
  /** The brand given matched no product. */
  brandMissing?: boolean;
}

export interface ServiceDeps {
  cache: Cache;
  health: HealthTracker;
  config: Config;
  logger: Logger;
}

const MAX_RESULTS = 5;
const SHORT_QUERY_WORDS = 3;
const MAX_NAME_QUERIES = 4;
const MAX_EAN_ENRICHMENTS = 5;
const RETRY_RATE_LIMITED_S = 30;
const RETRY_DEFAULT_S = 15;
const GOOD_MATCH_SCORE = 0.5;
/** Extra time spent fetching labels to preview candidates; what is late is left out (and cached for next time). */
const PREVIEW_WAIT_MS = 8000;

/** A label that does not state its basis gets one from the pack unit (ml → 100 ml, g → 100 g), marked as inferred. */
export function withInferredBasis(label: SourceLabel, packText: string | null): SourceLabel {
  if (label.basis !== "unknown") return label;
  const unit = parseQuantity(packText)?.unit;
  if (!unit) return label;
  return { ...label, basis: unit === "ml" ? "100ml" : "100g", basisInferred: true };
}

/**
 * Queries used to find a known product in a source that cannot search by barcode. Shop search engines often require
 * every word to match, and some titles omit the brand, so short queries come first: brand + key words, key words
 * alone, then the full name.
 */
export function nameQueries(hint: Pick<Offer, "name" | "brand">): string[] {
  const keyWords = nameTokens(hint.name).slice(0, SHORT_QUERY_WORDS).join(" ");
  const withBrand = `${hint.brand ?? ""} ${keyWords}`.trim();
  const full = `${hint.name} ${hint.brand ?? ""}`.trim();
  return [...new Set([withBrand, keyWords, full].filter((q) => q.length >= 2))];
}
const GROUP_TTL = { hitMs: 6 * 3600_000, missMs: 0 };
const VERIFY_CANDIDATES = 2;
const VARIANT_SIMILARITY = 0.4;
const MIN_RELEVANCE = 0.2;
const MIN_NULL_BRAND_RELEVANCE = 0.5;
const WEAK_SHOP_MATCH = 0.4;
const BATCH_CONCURRENCY = 3;
const AMBIGUOUS_ADVICE =
  "Several products match. Ask the user which one, then call get_label with its product_ref.";
const EXPIRED_ADVICE = "This product reference has expired. Search again with find_product.";
const UNKNOWN_BARCODE_ADVICE = "No source knows this barcode. Ask the user for the label on the pack.";
const NO_MATCH_ADVICE = "No product matches this query in any source.";
const PRICE_NOTE =
  "Total online list prices for the same product at lookup time; they can differ by shop, delivery zone or promotion.";

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The shops' results plausibly include the product: one matches the brand (if given) and the name reasonably well. */
function shopsFoundIt(offers: Offer[], query: string, brand: string | undefined): boolean {
  return offers.some(
    (o) =>
      (!brand || sameBrand(o.brand, brand) === true) &&
      tokenSimilarity(query, `${o.name} ${o.brand ?? ""}`) >= WEAK_SHOP_MATCH,
  );
}

/** A shop listing a product several times gives one label, not several votes: keep its most complete one. */
function onePerSource(labels: SourceLabel[]): SourceLabel[] {
  const best = new Map<SourceId, SourceLabel>();
  for (const label of labels) {
    const current = best.get(label.source);
    if (!current || Object.keys(label.values).length > Object.keys(current.values).length)
      best.set(label.source, label);
  }
  return [...best.values()];
}

/**
 * With a brand given, other brands are dropped when products of that brand were found (products without a brand stay
 * if their name matches well). Clearly unrelated results are dropped when better ones exist.
 */
export function relevantGroups(
  ranked: RankedGroup[],
  query: string,
  brand: string | undefined,
): RankedGroup[] {
  let kept = ranked;
  if (brand && ranked.some((g) => sameBrand(g.brand, brand) === true)) {
    kept = ranked.filter(
      (g) => sameBrand(g.brand, brand) === true || (!g.brand && g.score >= MIN_NULL_BRAND_RELEVANCE),
    );
  }
  const sharesWord = (g: RankedGroup) => g.offers.some((o) => sharesWordBesidesBrand(query, o.name, brand));
  if (kept.some(sharesWord)) kept = kept.filter(sharesWord);
  if (kept.some((g) => g.score >= MIN_RELEVANCE)) kept = kept.filter((g) => g.score >= MIN_RELEVANCE);
  return kept;
}

/** Orchestrates sources, identity and the decision engine for the MCP tools. */
export class NutritionService {
  private readonly byId: Map<SourceId, SourceAdapter>;
  private readonly tierOf: (s: SourceId) => Tier;

  private readonly adapters: SourceAdapter[];
  private readonly deps: ServiceDeps;

  constructor(adapters: SourceAdapter[], deps: ServiceDeps) {
    this.adapters = adapters;
    this.deps = deps;
    this.byId = new Map(adapters.map((a) => [a.id, a]));
    this.tierOf = (s) => this.byId.get(s)?.tier ?? "C";
  }

  listSources(): SourceInfo[] {
    const ids = this.adapters.map((a) => a.id);
    return this.deps.health.snapshot(ids).map((h) => {
      const a = this.byId.get(h.source);
      return {
        source: h.source,
        name: a?.displayName ?? h.source,
        tier: a?.tier ?? "C",
        search_by_text: a?.capabilities.text ?? false,
        search_by_barcode: a?.capabilities.ean ?? false,
        status: h.status,
        last_success_at: h.lastSuccessAt,
        last_failure_at: h.lastFailureAt,
        last_failure: h.lastFailure,
        calls_24h: h.calls24h,
        failures_24h: h.failures24h,
        p50_ms: h.p50Ms,
      };
    });
  }

  async findProduct(input: FindProductInput): Promise<FindProductResult> {
    const deadline = Date.now() + this.deps.config.requestBudgetMs;
    const limit = Math.min(input.limit ?? MAX_RESULTS, MAX_RESULTS);
    const adapters = this.selected(input.sources);
    const status: Statuses = { sources: {}, notes: [] };
    const ean = looksLikeBarcode(input.query) ? normalizeEan(input.query) : null;

    if (ean) {
      const groups = await this.groupsForEan(ean, adapters, deadline, status);
      this.remember(groups);
      return {
        query_kind: "barcode",
        products: groups.slice(0, limit).map((g) => productView(g, { tierOf: this.tierOf })),
        sources: status.sources,
        notes: status.notes,
      };
    }
    const top = (await this.rankedForText(input, adapters, deadline, status)).slice(0, limit);
    this.remember(top);
    await this.addPreviews(top, adapters, deadline);
    if (top.some((g) => g.match === "single_offer" && !g.ean))
      status.notes.push(
        "Products found in a single store without a barcode cannot be cross-checked by barcode.",
      );
    return {
      query_kind: "text",
      ...this.hints(status),
      products: top.map((g) => productView(g, { tierOf: this.tierOf, score: g.score })),
      sources: status.sources,
      notes: status.notes,
    };
  }

  async getLabel(input: GetLabelInput): Promise<GetLabelResult> {
    const result = await this.fullLabel(input);
    return input.compact ? compactLabelResult(result) : result;
  }

  private async fullLabel(input: GetLabelInput): Promise<GetLabelResult> {
    const deadline = Date.now() + this.deps.config.requestBudgetMs;
    const status: Statuses = { sources: {}, notes: [] };
    const adapters = this.selected(input.sources);
    let resolution = await this.resolve(input.product, input.brand, adapters, deadline, status);
    let resolvedBy: GetLabelResult["resolved_by"];

    if (resolution.kind === "ambiguous" && input.compareTo) {
      const candidates = resolution.ranked.slice(0, MAX_RESULTS);
      const verdicts = candidates.map((g) => {
        const preview = labelPreview(g, this.tierOf);
        return { g, verdict: preview ? previewVerdict(input.compareTo ?? {}, preview) : null };
      });
      // An exact match (within rounding) wins; values only within label tolerance must single out one product.
      const matching = verdicts.filter((v) => v.verdict === "match");
      const close = verdicts.filter((v) => v.verdict === "close");
      const picked =
        matching.length === 1
          ? matching[0]?.g
          : matching.length === 0 && close.length === 1
            ? close[0]?.g
            : undefined;
      if (picked) {
        resolution = { kind: "group", group: picked, ranked: resolution.ranked };
        resolvedBy = "compare_to";
        status.notes.push(
          `${candidates.length} products match the description; picked "${picked.name}", the only one whose label agrees with compare_to.`,
        );
      }
    }
    if (resolution.kind === "none")
      return { ...this.notFoundOrIncomplete(status, resolution.advice), ...this.hints(status) };
    if (resolution.kind === "ambiguous") {
      return {
        ...this.empty("ambiguous", status, AMBIGUOUS_ADVICE),
        ...this.hints(status),
        candidates: resolution.ranked.slice(0, MAX_RESULTS).map((g) => this.view(g)),
      };
    }

    const { group, ranked } = resolution;
    const labels = await this.labelsFor(group, deadline, status);
    const decided = decideLabel({ labels, productName: group.name, tierOf: this.tierOf });
    const product = productView(group, { tierOf: this.tierOf });
    const result: GetLabelResult = {
      status: "found",
      ...(resolvedBy ? { resolved_by: resolvedBy } : {}),
      ...this.hints(status),
      product,
      ...labelSection(decided),
      ready_to_apply: readyToApply(decided, product.pack),
      offers: group.offers.map(offerView),
      sources: status.sources,
      notes: status.notes,
    };
    if (input.compareTo && Object.keys(input.compareTo).length > 0) {
      result.comparison = compareWithLabel(input.compareTo, decided.nutrients);
    }
    if (input.includeRaw !== false) result.per_source = perSourceViews(decided);

    const others = ranked.filter((g) => g.ref !== group.ref);
    const variants = others.filter(
      (g) =>
        sameBrand(g.brand, group.brand) === true && tokenSimilarity(g.name, group.name) >= VARIANT_SIMILARITY,
    );
    if (variants.length > 0) result.variants = variants.slice(0, MAX_RESULTS).map((g) => this.view(g));

    const retry = this.retryHint(status);
    if (decided.confidence.overall === "none" && retry) {
      result.status = "incomplete";
      result.retry_after_s = retry.seconds;
      result.advice = `${retry.message} ${result.advice}`;
    }
    const similar = others.filter((g) => !variants.includes(g));
    if (decided.confidence.overall === "none" && similar.length > 0) {
      result.similar_products = similar.slice(0, MAX_RESULTS).map((g) => this.view(g));
      result.notes.push("similar_products are other products (often other brands), not the requested one.");
    }
    return result;
  }

  /**
   * Several products in one call. All barcodes are sent to Open Food Facts up front, where concurrent lookups share
   * requests; products are then processed a few at a time so shop queues stay within their time limits.
   */
  async getLabels(input: GetLabelsInput): Promise<GetLabelsResult> {
    const items = input.products.map((p): BatchItem => (typeof p === "string" ? { product: p } : p));
    const off = this.selected(input.sources).find((a) => a.id === "off");
    if (off) {
      for (const { product } of items) {
        const ean = product.startsWith("ean:")
          ? normalizeEan(product.slice(4))
          : looksLikeBarcode(product)
            ? normalizeEan(product)
            : null;
        if (ean) off.search({ ean, limit: 1 }).catch(() => undefined);
      }
    }
    const results = await mapWithConcurrency(items, BATCH_CONCURRENCY, async (item) => ({
      input: item.product,
      ...(await this.getLabel({
        ...item,
        sources: input.sources,
        includeRaw: input.includeRaw ?? false,
        compact: input.compact ?? true,
      })),
    }));
    return { results };
  }

  async comparePrices(input: ComparePricesInput): Promise<ComparePricesResult> {
    const deadline = Date.now() + this.deps.config.requestBudgetMs;
    const status: Statuses = { sources: {}, notes: [PRICE_NOTE] };
    const adapters = this.selected(input.sources);
    const base = { sources: status.sources, notes: status.notes } as const;

    const resolution = await this.resolve(input.product, input.brand, adapters, deadline, status);
    if (resolution.kind === "none")
      return { ...base, ...this.priceMiss(status), ...this.hints(status), product: null };
    if (resolution.kind === "ambiguous") {
      return {
        ...base,
        ...this.hints(status),
        status: "ambiguous",
        product: null,
        candidates: resolution.ranked.slice(0, MAX_RESULTS).map((g) => this.view(g)),
      };
    }
    const { group } = resolution;
    const offers = rankByPrice(group.offers);
    const views = offers.map(priceView);
    if (views.length === 0) status.notes.push("No store lists a price for this product.");
    return {
      ...base,
      ...this.hints(status),
      status: "found",
      product: productView(group, { tierOf: this.tierOf }),
      offers: views,
      cheapest: views[0] ?? null,
      spread: spreadOf(offers),
    };
  }

  /** Turns a product reference, barcode or description into one product (or candidates). */
  private async resolve(
    product: string,
    brand: string | undefined,
    adapters: SourceAdapter[],
    deadline: number,
    status: Statuses,
  ): Promise<Resolution> {
    const ref = product.trim();
    if (ref.startsWith("grp:")) {
      const group = this.deps.cache.get<ProductGroup>("group", ref);
      return group ? { kind: "group", group, ranked: [] } : { kind: "none", advice: EXPIRED_ADVICE };
    }
    const barcode = ref.startsWith("ean:")
      ? normalizeEan(ref.slice(4))
      : looksLikeBarcode(ref)
        ? normalizeEan(ref)
        : null;
    if (barcode) {
      const group =
        this.deps.cache.get<ProductGroup>("group", `ean:${barcode}`) ??
        (await this.groupsForEan(barcode, adapters, deadline, status))[0];
      if (!group) return { kind: "none", advice: UNKNOWN_BARCODE_ADVICE };
      this.remember([group]);
      return { kind: "group", group, ranked: [] };
    }
    const ranked = await this.rankedForText({ query: ref, brand }, adapters, deadline, status);
    this.remember(ranked.slice(0, MAX_RESULTS));
    const [first] = ranked;
    if (!first) return { kind: "none", advice: NO_MATCH_ADVICE };
    if (!isUnambiguous(ranked)) {
      await this.addPreviews(ranked.slice(0, MAX_RESULTS), adapters, deadline);
      return { kind: "ambiguous", ranked };
    }
    status.notes.push(`Resolved the query to "${first.name}"${first.brand ? ` (${first.brand})` : ""}.`);
    return { kind: "group", group: first, ranked };
  }

  private async rankedForText(
    input: FindProductInput,
    adapters: SourceAdapter[],
    deadline: number,
    status: Statuses,
  ): Promise<RankedGroup[]> {
    const groups = await this.groupsForText(input, adapters, deadline, status);
    const size = input.size ?? (parseQuantity(input.query) ? input.query : undefined);
    let brand = input.brand;
    if (brand && !groups.some((g) => sameBrand(g.brand, brand) === true)) {
      status.brandMissing = true;
      status.notes.push(`No product of brand ${brand} was found; the results are other brands.`);
    }
    if (!brand) {
      brand =
        brandInQuery(
          input.query,
          groups.map((g) => g.brand),
        ) ?? undefined;
      if (brand) status.notes.push(`Brand taken from the query: ${brand}.`);
    }
    const ranked = relevantGroups(
      rankGroups(groups, { query: input.query, brand, size }),
      input.query,
      brand,
    );
    if (ranked[0]) status.topScore = ranked[0].score;
    return ranked;
  }

  private remember(groups: ProductGroup[]): void {
    for (const g of groups) this.deps.cache.set("group", g.ref, g, GROUP_TTL.hitMs);
  }

  private view(g: RankedGroup | ProductGroup) {
    return productView(g, { tierOf: this.tierOf, score: "score" in g ? (g.score as number) : undefined });
  }

  private hints(status: Statuses): MatchHints {
    const hints: MatchHints = {};
    if (status.topScore !== undefined && status.topScore < GOOD_MATCH_SCORE) hints.no_good_match = true;
    if (status.brandMissing) hints.requested_brand_found = false;
    return hints;
  }

  /**
   * Fetches a label for products that have none yet, so they can carry a macro preview: from Open Food Facts by
   * barcode (concurrent lookups share one request) and from the best store's product page, in parallel. Failures and
   * late answers are ignored: previews are a convenience, not part of the result's completeness.
   */
  private async addPreviews(
    groups: ProductGroup[],
    adapters: SourceAdapter[],
    deadline: number,
  ): Promise<void> {
    const until = Math.min(deadline, Date.now() + PREVIEW_WAIT_MS);
    const off = adapters.find((a) => a.id === "off" && a.capabilities.ean);
    const missing = groups.filter((g) => !labelPreview(g, this.tierOf));
    if (missing.length === 0) return;
    const fromOff = async (g: ProductGroup) => {
      if (!g.ean || !off) return;
      const ean = g.ean;
      const outcome = await callSource(
        "off",
        () => off.search({ ean, limit: 1 }),
        until - Date.now(),
        this.deps.health,
      );
      const found = outcome.status === "ok" ? outcome.value.find((o) => o.label) : undefined;
      if (!found) return;
      const existing = g.offers.find((o) => o.source === "off");
      if (existing) existing.label = found.label;
      else g.offers.push(found);
    };
    const fromStore = async (g: ProductGroup) => {
      const offer = g.offers.find((o) => this.byId.has(o.source) && o.source !== "off");
      const adapter = offer && this.byId.get(offer.source);
      if (!offer || !adapter) return;
      const outcome = await callSource(
        offer.source,
        () => adapter.getLabel(offer),
        Math.min(until - Date.now(), this.remaining(deadline, offer.source)),
        this.deps.health,
      );
      if (outcome.status === "ok" && outcome.value.label) offer.label = outcome.value.label;
    };
    await Promise.all(missing.flatMap((g) => [fromOff(g), fromStore(g)]));
    this.remember(groups);
  }

  private priceMiss(status: Statuses): Pick<ComparePricesResult, "status" | "retry_after_s"> {
    const retry = this.retryHint(status);
    return retry ? { status: "incomplete", retry_after_s: retry.seconds } : { status: "not_found" };
  }

  // ── flows ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private selected(ids?: SourceId[]): SourceAdapter[] {
    if (!ids || ids.length === 0) return this.adapters;
    return this.adapters.filter((a) => ids.includes(a.id));
  }

  /**
   * Time left for a source call. Open Food Facts calls may wait longer (OFF_MAX_WAIT_MS from the request start) since
   * its lookups are queued to respect its quotas; other sources keep the per-source and per-request limits.
   */
  private remaining(deadline: number, source?: SourceId): number {
    const { sourceTimeoutMs, requestBudgetMs, offMaxWaitMs } = this.deps.config;
    if (source === "off") return Math.max(0, deadline - requestBudgetMs + offMaxWaitMs - Date.now());
    return Math.min(sourceTimeoutMs, deadline - Date.now());
  }

  private record(status: Statuses, source: SourceId, outcome: SourceStatus): void {
    status.sources[source] = mergeStatus(status.sources[source], outcome);
  }

  private async search(
    adapter: SourceAdapter,
    query: { text?: string; ean?: string; brand?: string; limit: number },
    deadline: number,
    status: Statuses,
  ): Promise<Offer[]> {
    const outcome = await callSource(
      adapter.id,
      () => adapter.search(query),
      this.remaining(deadline, adapter.id),
      this.deps.health,
    );
    if (outcome.status !== "ok") {
      this.record(status, adapter.id, outcome.status);
      return [];
    }
    this.record(status, adapter.id, outcome.value.length > 0 ? "ok" : "not_found");
    return outcome.value;
  }

  private async groupsForText(
    input: FindProductInput,
    adapters: SourceAdapter[],
    deadline: number,
    status: Statuses,
  ): Promise<ProductGroup[]> {
    const query = { text: input.query, brand: input.brand, limit: MAX_RESULTS };
    const shops = adapters.filter((a) => a.capabilities.text && a.id !== "off");
    const offers = (await Promise.all(shops.map((a) => this.search(a, query, deadline, status)))).flat();
    // Open Food Facts name search is heavily rate limited: only use it when the shops did not find the product.
    const off = adapters.find((a) => a.id === "off" && a.capabilities.text);
    if (off && !shopsFoundIt(offers, input.query, input.brand)) {
      offers.push(...(await this.search(off, query, deadline, status)));
    }
    const ranked = rankGroups(groupOffers(offers, this.tierOf), {
      query: input.query,
      brand: input.brand,
      size: input.size,
    });
    // Brand names differ between shops (maker vs product line), so barcodes are what joins offers: fetch the missing
    // ones for the best candidates from their product page (cached, and it prefetches the label as well).
    const missing = ranked
      .slice(0, MAX_RESULTS)
      .flatMap((g) => g.offers)
      .filter((o) => !o.ean)
      .slice(0, MAX_EAN_ENRICHMENTS);
    if (missing.length === 0) return ranked;
    await Promise.all(missing.map((o) => this.enrichEan(o, deadline, status)));
    return groupOffers(offers, this.tierOf);
  }

  private async enrichEan(offer: Offer, deadline: number, status: Statuses): Promise<void> {
    const adapter = this.byId.get(offer.source);
    if (!adapter) return;
    const outcome = await callSource(
      offer.source,
      () => adapter.getLabel(offer),
      this.remaining(deadline, offer.source),
      this.deps.health,
    );
    if (outcome.status !== "ok") {
      this.record(status, offer.source, outcome.status);
      return;
    }
    if (outcome.value.ean) offer.ean = outcome.value.ean;
    if (outcome.value.label && !offer.label) offer.label = outcome.value.label;
  }

  /**
   * Barcode flow: direct barcode lookups first; then sources that cannot look a barcode up are searched by the
   * product name learnt in the first step, keeping only hits with the same barcode (verified on the page if needed).
   */
  private async groupsForEan(
    ean: string,
    adapters: SourceAdapter[],
    deadline: number,
    status: Statuses,
  ): Promise<ProductGroup[]> {
    const direct = adapters.filter((a) => a.capabilities.ean && a.id !== "off");
    const indirect = adapters.filter((a) => !a.capabilities.ean && a.capabilities.text);
    const offAdapter = adapters.find((a) => a.id === "off" && a.capabilities.ean);
    const fromOff = offAdapter
      ? this.search(offAdapter, { ean, limit: 1 }, deadline, status)
      : Promise.resolve([]);
    const found = (
      await Promise.all(direct.map((a) => this.search(a, { ean, limit: 3 }, deadline, status)))
    ).flat();
    // Open Food Facts may be queued for a while: only wait for it before the name searches when no shop knows the
    // barcode, since its name is then the only hint.
    if (found.length === 0) found.push(...(await fromOff));

    // Shop names are usually French and descriptive; Open Food Facts names can be terse or in English.
    const hints = [
      ...found.filter((o) => o.source !== "off" && o.brand),
      ...found.filter((o) => o.source === "off"),
    ];
    const hint = hints[0] ?? found[0];
    if (hint) {
      const brand = hints.find((h) => h.brand)?.brand ?? undefined;
      const queries = [...new Set(hints.slice(0, 2).flatMap(nameQueries))].slice(0, MAX_NAME_QUERIES);
      const viaName = await Promise.all(
        indirect.map(async (a) => {
          const candidates = new Map<string, Offer>();
          for (const text of queries) {
            const offers = await this.search(a, { text, brand, limit: MAX_RESULTS }, deadline, status);
            const exact = offers.filter((o) => o.ean === ean);
            if (exact.length > 0) return exact;
            for (const o of offers) candidates.set(o.sourceProductId, o);
          }
          return this.verifyByPage(a, [...candidates.values()], hint, ean, deadline, status);
        }),
      );
      found.push(...viaName.flat());
    } else {
      for (const a of indirect) this.record(status, a.id, "not_supported");
    }
    for (const offer of await fromOff) if (!found.includes(offer)) found.push(offer);
    const groups = groupOffers(found, this.tierOf);
    return groups.filter((g) => g.ean === ean);
  }

  /** For sources that only reveal the barcode on the product page (La Vie Claire). */
  private async verifyByPage(
    adapter: SourceAdapter,
    offers: Offer[],
    hint: Offer,
    ean: string,
    deadline: number,
    status: Statuses,
  ): Promise<Offer[]> {
    const plausible = offers
      .filter((o) => !o.ean && sameBrand(o.brand, hint.brand) !== false)
      .map((o) => ({ o, similarity: tokenSimilarity(o.name, hint.name) }))
      .filter((x) => x.similarity >= 0.4)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, VERIFY_CANDIDATES)
      .map((x) => x.o);
    const verified: Offer[] = [];
    for (const offer of plausible) {
      const outcome = await callSource(
        adapter.id,
        () => adapter.getLabel(offer),
        this.remaining(deadline, adapter.id),
        this.deps.health,
      );
      if (outcome.status !== "ok") {
        this.record(status, adapter.id, outcome.status);
        continue;
      }
      if (outcome.value.ean === ean) {
        verified.push({ ...offer, ean, label: outcome.value.label ?? undefined });
      }
    }
    return verified;
  }

  private async labelsFor(group: ProductGroup, deadline: number, status: Statuses): Promise<SourceLabel[]> {
    const outcomes = await Promise.all(
      group.offers.map(async (offer) => {
        if (offer.label) return { offer, label: offer.label, ean: offer.ean };
        const adapter = this.byId.get(offer.source);
        if (!adapter) return null;
        const outcome = await callSource(
          offer.source,
          () => adapter.getLabel(offer),
          this.remaining(deadline, offer.source),
          this.deps.health,
        );
        if (outcome.status !== "ok") {
          this.record(status, offer.source, outcome.status);
          return null;
        }
        return { offer, label: outcome.value.label, ean: outcome.value.ean ?? null };
      }),
    );
    const labels: SourceLabel[] = [];
    for (const o of outcomes) {
      if (!o?.label) continue;
      if (group.ean && o.ean && o.ean !== group.ean) {
        status.notes.push(`${o.offer.source} page shows another barcode (${o.ean}); its label was ignored.`);
        continue;
      }
      labels.push(withInferredBasis(o.label, o.offer.sizeText ?? group.sizeText ?? o.offer.name));
    }
    return onePerSource(labels);
  }

  /** When sources failed, an empty answer is not final: say so and suggest when to retry. */
  private retryHint(status: Statuses): { seconds: number; message: string } | null {
    const failed = Object.entries(status.sources).filter(
      ([, s]) => s === "timeout" || s === "rate_limited" || s === "error",
    );
    if (failed.length === 0) return null;
    const seconds = failed.some(([, s]) => s === "rate_limited") ? RETRY_RATE_LIMITED_S : RETRY_DEFAULT_S;
    const list = failed.map(([source, s]) => `${source} (${s})`).join(", ");
    return { seconds, message: `Incomplete: ${list} did not answer. Retry in about ${seconds} s.` };
  }

  private notFoundOrIncomplete(status: Statuses, advice: string): GetLabelResult {
    const retry = this.retryHint(status);
    if (!retry) return this.empty("not_found", status, advice);
    return { ...this.empty("incomplete", status, retry.message), retry_after_s: retry.seconds };
  }

  private empty(kind: GetLabelResult["status"], status: Statuses, advice: string): GetLabelResult {
    return {
      status: kind,
      product: null,
      label: null,
      confidence: null,
      advice,
      ingredients: null,
      allergens: null,
      traces: null,
      offers: [],
      sources: status.sources,
      notes: status.notes,
    };
  }
}
