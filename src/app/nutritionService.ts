import type { Config } from "../config.ts";
import { looksLikeBarcode, normalizeEan } from "../domain/ean.ts";
import { nameTokens, sameBrand, tokenSimilarity } from "../domain/text.ts";
import type { Offer, SourceId, SourceLabel, Tier } from "../domain/types.ts";
import { decideLabel } from "../engine/decide.ts";
import { groupOffers, isUnambiguous, type ProductGroup, rankGroups } from "../engine/identity.ts";
import type { Cache } from "../infra/cache.ts";
import type { HealthTracker } from "../infra/health.ts";
import type { Logger } from "../infra/logger.ts";
import type { SourceAdapter } from "../sources/adapter.ts";
import { labelSection, offerView, perSourceViews, productView } from "./present.ts";
import { callSource, mergeStatus } from "./sourceCall.ts";
import type { FindProductResult, GetLabelResult, SourceInfo, SourceStatus } from "./types.ts";

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
  includeRaw?: boolean;
}

interface Statuses {
  sources: Partial<Record<SourceId, SourceStatus>>;
  notes: string[];
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

    const groups = ean
      ? await this.groupsForEan(ean, adapters, deadline, status)
      : await this.groupsForText(input, adapters, deadline, status);
    const ranked = ean
      ? groups
      : rankGroups(groups, { query: input.query, brand: input.brand, size: input.size });
    const top = ranked.slice(0, limit);
    for (const g of top) this.deps.cache.set("group", g.ref, g, GROUP_TTL.hitMs);
    if (!ean && top.some((g) => g.match === "single_offer" && !g.ean))
      status.notes.push(
        "Products found in a single store without a barcode cannot be cross-checked by barcode.",
      );
    return {
      query_kind: ean ? "barcode" : "text",
      products: top.map(productView),
      sources: status.sources,
      notes: status.notes,
    };
  }

  async getLabel(input: GetLabelInput): Promise<GetLabelResult> {
    const deadline = Date.now() + this.deps.config.requestBudgetMs;
    const status: Statuses = { sources: {}, notes: [] };
    const adapters = this.adapters;
    const ref = input.product.trim();

    let group: ProductGroup | null = null;
    let others: ProductGroup[] = [];
    if (ref.startsWith("grp:") || ref.startsWith("ean:")) {
      group = this.deps.cache.get<ProductGroup>("group", ref) ?? null;
      if (!group && ref.startsWith("ean:")) {
        const ean = normalizeEan(ref.slice(4));
        if (ean) group = (await this.groupsForEan(ean, adapters, deadline, status))[0] ?? null;
      }
      if (!group)
        return this.empty(
          "not_found",
          status,
          "This product reference has expired. Search again with find_product.",
        );
    } else if (looksLikeBarcode(ref)) {
      const ean = normalizeEan(ref);
      group = ean ? ((await this.groupsForEan(ean, adapters, deadline, status))[0] ?? null) : null;
      if (!group)
        return this.empty(
          "not_found",
          status,
          "No source knows this barcode. Ask the user for the label on the pack.",
        );
    } else {
      const groups = rankGroups(
        await this.groupsForText({ query: ref, brand: input.brand }, adapters, deadline, status),
        {
          query: ref,
          brand: input.brand,
        },
      );
      for (const g of groups.slice(0, MAX_RESULTS)) this.deps.cache.set("group", g.ref, g, GROUP_TTL.hitMs);
      if (groups.length === 0)
        return this.empty("not_found", status, "No product matches this query in any source.");
      if (!isUnambiguous(groups)) {
        return {
          ...this.empty(
            "ambiguous",
            status,
            "Several products match. Ask the user which one, then call get_label with its product_ref.",
          ),
          candidates: groups.slice(0, MAX_RESULTS).map(productView),
        };
      }
      group = groups[0] ?? null;
      others = groups.slice(1, MAX_RESULTS + 1);
      if (group)
        status.notes.push(`Resolved the query to "${group.name}"${group.brand ? ` (${group.brand})` : ""}.`);
    }
    if (!group) return this.empty("not_found", status, "No product matches this query in any source.");

    const labels = await this.labelsFor(group, deadline, status);
    const decided = decideLabel({ labels, productName: group.name, tierOf: this.tierOf });
    const result: GetLabelResult = {
      status: "found",
      product: productView(group),
      ...labelSection(decided),
      offers: group.offers.map(offerView),
      sources: status.sources,
      notes: status.notes,
    };
    if (input.includeRaw !== false) result.per_source = perSourceViews(decided);
    if (decided.confidence.overall === "none" && others.length > 0) {
      result.similar_products = others.map(productView);
      result.notes.push("similar_products are other products (often other brands), not the requested one.");
    }
    const late = Object.entries(status.sources)
      .filter(([, s]) => s === "timeout")
      .map(([s]) => s);
    if (late.length > 0)
      result.notes.push(
        `Still loading from ${late.join(", ")}; calling again shortly may add these sources.`,
      );
    return result;
  }

  // ── flows ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private selected(ids?: SourceId[]): SourceAdapter[] {
    if (!ids || ids.length === 0) return this.adapters;
    return this.adapters.filter((a) => ids.includes(a.id));
  }

  private remaining(deadline: number): number {
    return Math.min(this.deps.config.sourceTimeoutMs, deadline - Date.now());
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
      this.remaining(deadline),
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
    const textAdapters = adapters.filter((a) => a.capabilities.text);
    const results = await Promise.all(
      textAdapters.map((a) =>
        this.search(a, { text: input.query, brand: input.brand, limit: MAX_RESULTS }, deadline, status),
      ),
    );
    const offers = results.flat();
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
      this.remaining(deadline),
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
    const direct = adapters.filter((a) => a.capabilities.ean);
    const indirect = adapters.filter((a) => !a.capabilities.ean && a.capabilities.text);
    const found = (
      await Promise.all(direct.map((a) => this.search(a, { ean, limit: 3 }, deadline, status)))
    ).flat();

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
        this.remaining(deadline),
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
          this.remaining(deadline),
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
      labels.push(o.label);
    }
    return labels;
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
