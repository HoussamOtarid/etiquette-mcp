import type { NutrientKey } from "../domain/nutrients.ts";
import type { Offer } from "../domain/types.ts";
import type { ProductGroup } from "../engine/identity.ts";
import type { DecidedLabel, NutrientDecision } from "../engine/types.ts";
import type { GetLabelResult, NutrientView, OfferView, PerSourceView, ProductView } from "./types.ts";

export function offerView(o: Offer): OfferView {
  return {
    source: o.source,
    name: o.name,
    brand: o.brand,
    url: o.url,
    price_eur: o.priceEur,
    unit_price: o.unitPriceText,
    in_stock: o.inStock,
  };
}

export function productView(g: ProductGroup): ProductView {
  return {
    product_ref: g.ref,
    ean: g.ean,
    name: g.name,
    brand: g.brand,
    size: g.sizeText,
    match: g.match,
    offers: g.offers.map(offerView),
  };
}

function nutrientView(n: NutrientDecision): NutrientView {
  const view: NutrientView = {
    value: n.value,
    agreement: n.agreement,
    sources_agree: n.sourcesAgree,
    sources_total: n.sourcesTotal,
    supporting: n.supporting,
  };
  if (n.qualifier) view.qualifier = n.qualifier;
  if (n.dissent.length > 0) view.dissent = n.dissent.map(({ source, value }) => ({ source, value }));
  if (n.bestGuess !== undefined) view.best_guess = n.bestGuess;
  return view;
}

export function labelSection(
  d: DecidedLabel,
): Pick<GetLabelResult, "label" | "confidence" | "advice" | "ingredients" | "allergens" | "traces"> {
  const nutrients: Partial<Record<NutrientKey, NutrientView>> = {};
  for (const [key, n] of Object.entries(d.nutrients) as Array<[NutrientKey, NutrientDecision]>) {
    nutrients[key] = nutrientView(n);
  }
  return {
    label: { basis: d.basis, nutrients, nutriscore: d.nutriscore },
    confidence: {
      overall: d.confidence.overall,
      sources_with_label: d.confidence.sourcesWithLabel,
      independent_sources: d.confidence.independentSources,
      missing_nutrients: d.missing,
      self_check: d.confidence.selfCheck,
      flags: d.confidence.flags,
    },
    advice: d.advice,
    ingredients: d.ingredients,
    allergens: d.allergens,
    traces: d.traces,
  };
}

export function perSourceViews(d: DecidedLabel): PerSourceView[] {
  return d.perSource.map((l) => ({
    source: l.source,
    url: l.original.url,
    fetched_at: l.original.fetchedAt,
    basis: l.basis,
    structured: l.values,
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
