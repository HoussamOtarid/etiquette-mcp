import { round } from "../domain/numbers.ts";
import { CORE_NUTRIENTS, type NutrientKey, SALT_PER_SODIUM } from "../domain/nutrients.ts";
import { parseQuantity } from "../domain/quantity.ts";
import { sameBrand, tokenSimilarity } from "../domain/text.ts";
import type { Basis, Offer, SourceId, Tier } from "../domain/types.ts";
import type { ProductGroup } from "../engine/identity.ts";
import type { DecidedLabel, NutrientDecision } from "../engine/types.ts";
import type {
  FlatValues,
  GetLabelResult,
  LabelPreview,
  NutrientView,
  OfferView,
  PackSize,
  PerSourceView,
  PriceView,
  ProductView,
  ReadyToApply,
} from "./types.ts";

const TIER_RANK: Record<Tier, number> = { A: 0, B: 1, C: 2 };

/** Values as labels print them: energy to the unit, masses to two decimals. */
export function displayValue(key: NutrientKey | "sodium_g", value: number): number {
  return round(value, key.startsWith("energy") ? 0 : key === "sodium_g" ? 3 : 2);
}

function displayValues(values: Partial<Record<NutrientKey, number>>): Partial<Record<NutrientKey, number>> {
  const out: Partial<Record<NutrientKey, number>> = {};
  for (const [key, value] of Object.entries(values) as Array<[NutrientKey, number]>)
    out[key] = displayValue(key, value);
  return out;
}

export function offerView(o: Offer): OfferView {
  return {
    source: o.source,
    name: o.name,
    brand: o.brand,
    url: o.url,
    price_eur: o.priceEur,
    in_stock: o.inStock,
  };
}

export function packOf(g: Pick<ProductGroup, "sizeText" | "name" | "offers">): PackSize | null {
  const texts = [g.sizeText, ...g.offers.map((o) => o.sizeText), g.name, ...g.offers.map((o) => o.name)];
  for (const text of texts) {
    const q = parseQuantity(text);
    if (q) return { amount: q.amount, unit: q.unit };
  }
  return null;
}

export function labelPreview(g: ProductGroup, tierOf: (s: SourceId) => Tier): LabelPreview | undefined {
  const withLabel = g.offers
    .filter((o) => o.label && Object.keys(o.label.values).length > 0)
    .sort((a, b) => TIER_RANK[tierOf(a.source)] - TIER_RANK[tierOf(b.source)]);
  const label = withLabel[0]?.label;
  if (!label) return undefined;
  const v = (key: NutrientKey) => {
    const value = label.values[key]?.value;
    return value === undefined ? null : displayValue(key, value);
  };
  return {
    source: label.source,
    basis: label.basis,
    energy_kcal: v("energy_kcal"),
    protein_g: v("protein_g"),
    carbohydrates_g: v("carbohydrates_g"),
    fat_g: v("fat_g"),
  };
}

/** Other pack sizes of a product, found to carry the same label. */
export type WithOtherSizes = ProductGroup & { otherSizes?: ProductGroup[] };

export function productView(
  g: WithOtherSizes,
  options: { tierOf?: (s: SourceId) => Tier; score?: number } = {},
): ProductView {
  const view: ProductView = {
    product_ref: g.ref,
    ean: g.ean,
    name: g.name,
    brand: g.brand,
    size: g.sizeText,
    pack: packOf(g),
    match: g.match,
    offers: g.offers.map(offerView),
  };
  if (options.score !== undefined) view.score = options.score;
  const preview = options.tierOf ? labelPreview(g, options.tierOf) : undefined;
  if (preview) view.label_preview = preview;
  if (g.otherSizes?.length)
    view.other_sizes = g.otherSizes.map((o) => ({ product_ref: o.ref, size: o.sizeText ?? packText(o) }));
  return view;
}

function packText(g: ProductGroup): string | null {
  const pack = packOf(g);
  return pack ? `${pack.amount} ${pack.unit}` : null;
}

/**
 * The same product in several pack sizes: same brand, same name apart from quantities, and identical label previews.
 * Each such set becomes one entry (the best ranked), listing the others as `otherSizes`.
 */
export function mergePackSizes<T extends ProductGroup>(
  ranked: T[],
  tierOf: (s: SourceId) => Tier,
): Array<T & { otherSizes?: ProductGroup[] }> {
  const sameLabel = (a: ProductGroup, b: ProductGroup) => {
    const pa = labelPreview(a, tierOf);
    const pb = labelPreview(b, tierOf);
    if (!pa || !pb || !compatibleBasis(pa.basis, pb.basis)) return false;
    return (["energy_kcal", "protein_g", "carbohydrates_g", "fat_g"] as const).every((k) => pa[k] === pb[k]);
  };
  const merged: Array<T & { otherSizes?: ProductGroup[] }> = [];
  for (const g of ranked) {
    const home = merged.find(
      (m) =>
        (sameBrand(m.brand, g.brand) === true || (!m.brand && !g.brand)) &&
        tokenSimilarity(m.name, g.name) === 1 &&
        sameLabel(m, g),
    );
    if (home) home.otherSizes = [...(home.otherSizes ?? []), g];
    else merged.push({ ...g });
  }
  return merged;
}

/** Labels "per 100 g or ml" fit either basis; an unknown basis fits none. */
function compatibleBasis(a: Basis, b: Basis): boolean {
  if (a === "unknown" || b === "unknown") return false;
  return a === b || a === "100g/100ml" || b === "100g/100ml";
}

function nutrientView(n: NutrientDecision): NutrientView {
  const view: NutrientView = {
    value: n.value === null ? null : displayValue(n.key, n.value),
    agreement: n.agreement,
    sources_agree: n.sourcesAgree,
    sources_total: n.sourcesTotal,
    supporting: n.supporting,
  };
  if (n.qualifier) view.qualifier = n.qualifier;
  if (n.dissent.length > 0)
    view.dissent = n.dissent.map(({ source, value }) => ({ source, value: displayValue(n.key, value) }));
  if (n.bestGuess !== undefined) view.best_guess = displayValue(n.key, n.bestGuess);
  return view;
}

export function labelSection(
  d: DecidedLabel,
): Pick<GetLabelResult, "label" | "confidence" | "advice" | "ingredients" | "allergens" | "traces"> {
  const nutrients: Partial<Record<NutrientKey, NutrientView>> = {};
  for (const [key, n] of Object.entries(d.nutrients) as Array<[NutrientKey, NutrientDecision]>) {
    nutrients[key] = nutrientView(n);
  }
  const ingredientsSource = d.perSource.find((l) => l.source === d.ingredients?.source);
  return {
    label: { basis: d.basis, nutrients, nutriscore: d.nutriscore },
    confidence: {
      overall: d.confidence.overall,
      sources_with_label: d.confidence.sourcesWithLabel,
      independent_sources: d.confidence.independentSources,
      missing_nutrients: d.missing,
      self_check: d.confidence.selfCheck,
      flags: d.confidence.flags,
      flag_details: d.confidence.flagDetails,
    },
    advice: d.advice,
    ingredients: d.ingredients
      ? { ...d.ingredients, lang: ingredientsSource?.original.ingredientsLang ?? null }
      : null,
    allergens: d.allergens,
    traces: d.traces,
  };
}

function scale(values: FlatValues, factor: number): FlatValues {
  const out: FlatValues = {};
  for (const [key, value] of Object.entries(values) as Array<[NutrientKey | "sodium_g", number | null]>) {
    out[key] = value === null ? null : displayValue(key, value * factor);
  }
  return out;
}

/** The source agrees with every core nutrient chosen. */
function supportsCore(d: DecidedLabel, source: SourceId): boolean {
  return CORE_NUTRIENTS.every((k) => d.nutrients[k]?.supporting.includes(source) === true);
}

function flatValues(values: Partial<Record<NutrientKey, { value: number }>>): FlatValues {
  const out: FlatValues = {};
  for (const [key, v] of Object.entries(values) as Array<[NutrientKey, { value: number }]>)
    out[key] = displayValue(key, v.value);
  const salt = out.salt_g;
  if (salt !== undefined && salt !== null) out.sodium_g = displayValue("sodium_g", salt / SALT_PER_SODIUM);
  return out;
}

export function readyToApply(d: DecidedLabel, pack: PackSize | null): ReadyToApply {
  const per100: FlatValues = {};
  const qualifiers: ReadyToApply["qualifiers"] = {};
  const conflicts: NonNullable<ReadyToApply["conflicts"]> = [];
  for (const [key, n] of Object.entries(d.nutrients) as Array<[NutrientKey, NutrientDecision]>) {
    per100[key] = n.value === null ? null : displayValue(key, n.value);
    if (n.qualifier) qualifiers[key] = n.qualifier;
    if (n.agreement === "conflict")
      conflicts.push({
        nutrient: key,
        values: n.dissent.map(({ source, value }) => ({ source, value: displayValue(key, value) })),
        best_guess: n.bestGuess === undefined ? null : displayValue(key, n.bestGuess),
      });
  }
  const salt = per100.salt_g;
  if (salt !== undefined)
    per100.sodium_g = salt === null ? null : displayValue("sodium_g", salt / SALT_PER_SODIUM);
  const compatible =
    pack !== null &&
    (d.basis === "100g/100ml" ||
      (d.basis === "100g" && pack.unit === "g") ||
      (d.basis === "100ml" && pack.unit === "ml"));
  // Per-portion values are taken as printed, from a label whose per-100 values are the ones chosen.
  const portioned = d.perSource
    .filter((l) => l.original.portion && (l.brandOwner || supportsCore(d, l.source)))
    .sort((a, b) => Number(b.brandOwner) - Number(a.brandOwner))[0]?.original.portion;
  const result: ReadyToApply = {
    basis: d.basis,
    per_100: per100,
    qualifiers,
    pack,
    per_pack: compatible && pack ? scale(per100, pack.amount / 100) : null,
    portion: portioned
      ? { description: portioned.description, amount: portioned.amount, unit: portioned.unit }
      : null,
    per_portion: portioned ? flatValues(portioned.values) : null,
  };
  if (conflicts.length > 0) result.conflicts = conflicts;
  return result;
}

/** A product without its offers list: just the stores selling it. */
export function compactProduct(p: ProductView): ProductView {
  const { offers, ...rest } = p;
  return { ...rest, stores: [...new Set((offers ?? []).map((o) => o.source))] };
}

/**
 * The label without bulky parts: offers (stores only), per-source labels, ingredients, allergens, traces, variants
 * and similar products.
 */
export function compactLabelResult(r: GetLabelResult): GetLabelResult {
  const { offers, per_source, ingredients, allergens, traces, variants, similar_products, ...rest } = r;
  const label = r.label && {
    ...r.label,
    nutrients: Object.fromEntries(
      Object.entries(r.label.nutrients).map(([key, n]) => [
        key,
        {
          value: n.value,
          agreement: n.agreement,
          ...(n.qualifier ? { qualifier: n.qualifier } : {}),
          ...(n.best_guess !== undefined ? { best_guess: n.best_guess } : {}),
        },
      ]),
    ),
  };
  return {
    ...rest,
    label,
    product: r.product ? compactProduct(r.product) : null,
    ...(r.candidates ? { candidates: r.candidates.map(compactProduct) } : {}),
  };
}

export function perSourceViews(d: DecidedLabel): PerSourceView[] {
  return d.perSource.map((l) => ({
    source: l.source,
    url: l.original.url,
    fetched_at: l.original.fetchedAt,
    last_updated: l.original.updatedAt ?? null,
    basis: l.basis,
    structured: displayValues(l.values),
    raw_label: l.original.raw,
    extra_nutrients: l.original.extra,
    self_check: {
      status: l.selfCheck.status,
      kcal_stated: l.selfCheck.kcalStated,
      kcal_from_macros: l.selfCheck.kcalFromMacros,
    },
    flags: l.flags,
    notes: l.notes,
    data_origin: l.original.dataOrigin ?? null,
  }));
}

export function priceView(offer: Offer): PriceView {
  return {
    source: offer.source,
    name: offer.name,
    brand: offer.brand,
    url: offer.url,
    price_eur: offer.priceEur ?? 0,
    in_stock: offer.inStock,
  };
}
