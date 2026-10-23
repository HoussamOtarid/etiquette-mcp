import type { NutrientKey } from "../domain/nutrients.ts";
import type { Offer } from "../domain/types.ts";
import { TTL } from "../infra/cache.ts";
import { HttpError } from "../infra/http.ts";
import {
  type AdapterDeps,
  cleanText,
  emptyLabel,
  finalizeLabel,
  type LabelResult,
  type SearchQuery,
  type SourceAdapter,
} from "./adapter.ts";
import { cachedSearch, eanOf, matchingEan, priceOf, setNumber } from "./shared.ts";

const HOME_URL = "https://lafourche.fr/";
const INDEX = "production_products";

export interface AlgoliaCredentials {
  appId: string;
  apiKey: string;
}

interface Hit {
  objectID?: string;
  title?: string;
  vendor?: string;
  barcode?: string;
  handle?: string;
  price?: number;
  weight?: string;
  inventory_available?: boolean;
  meta?: {
    marketing?: {
      nutritional_values_table_data?: string;
      nutritional_values?: string;
      nutritional_values_as_text?: string;
      nutriscore_grade?: string;
      ingredients?: string;
      allergen?: string;
    };
  };
}

const TABLE_KEYS: Record<string, NutrientKey> = {
  fat_100g: "fat_g",
  "saturated-fat_100g": "saturated_fat_g",
  carbohydrates_100g: "carbohydrates_g",
  sugars_100g: "sugars_g",
  fiber_100g: "fiber_g",
  proteins_100g: "protein_g",
  salt_100g: "salt_g",
};

/** Finds the public search credentials the storefront ships in its page data. */
export function extractAlgoliaCredentials(html: string): AlgoliaCredentials | null {
  const m =
    /"algoliaConfig"\s*:\s*\{\s*"app"\s*:\s*\{\s*"id"\s*:\s*"([A-Z0-9]+)"\s*,\s*"key"\s*:\s*"([a-f0-9]+)"/.exec(
      html,
    );
  return m?.[1] && m[2] ? { appId: m[1], apiKey: m[2] } : null;
}

export function parseLaFourcheHit(hit: Hit): Offer | null {
  if (!hit.handle || !hit.title) return null;
  const url = `https://lafourche.fr/products/${hit.handle}`;
  const marketing = hit.meta?.marketing ?? {};
  const label = emptyLabel("lafourche", url);
  if (marketing.nutritional_values_table_data) {
    try {
      const table = JSON.parse(marketing.nutritional_values_table_data) as {
        header?: string[];
        body?: string[][];
      };
      const basis = (table.header?.[1] ?? "").toLowerCase();
      label.basis = basis.includes("ml") ? "100ml" : "100g";
      for (const [key, value] of table.body ?? []) {
        if (!key || value === undefined) continue;
        if (key === "energy_100g") {
          setNumber(label.values, "energy_kj", /([\d.,]+)\s*kj/i.exec(value)?.[1]);
          setNumber(label.values, "energy_kcal", /([\d.,]+)\s*kcal/i.exec(value)?.[1]);
        } else if (key === "sodium_100g") {
          const n = Number.parseFloat(value.replace(",", "."));
          if (Number.isFinite(n)) label.sodiumG = n;
        } else {
          const canonical = TABLE_KEYS[key];
          if (canonical) setNumber(label.values, canonical, value);
          else
            label.extra.push({
              name: key,
              value: Number.parseFloat(value) || null,
              unit: null,
              raw: `${key}: ${value}`,
            });
        }
      }
    } catch {
      // malformed table: keep the free-text version only
    }
  }
  label.raw = cleanText(marketing.nutritional_values ?? marketing.nutritional_values_as_text);
  label.nutriscore = cleanText(marketing.nutriscore_grade);
  label.ingredients = cleanText(marketing.ingredients);
  label.allergens = cleanText(marketing.allergen);
  label.dataOrigin = "store";
  finalizeLabel(label);

  return {
    source: "lafourche",
    sourceProductId: hit.handle,
    url,
    name: hit.title,
    brand: cleanText(hit.vendor),
    ean: eanOf(hit.barcode),
    sizeText: cleanText(hit.weight),
    priceEur: priceOf(hit.price),
    unitPriceText: null,
    inStock: typeof hit.inventory_available === "boolean" ? hit.inventory_available : null,
    label,
  };
}

/**
 * La Fourche: online organic shop. Its search index returns the full nutrition table, so one call gives search
 * results and labels. The barcode is in each hit but is not searchable, so barcode lookups go through name search.
 */
export class LaFourcheAdapter implements SourceAdapter {
  readonly id = "lafourche" as const;
  readonly tier = "A" as const;
  readonly displayName = "La Fourche";
  readonly capabilities = { text: true, ean: false };

  constructor(private readonly deps: AdapterDeps) {}

  async search(query: SearchQuery): Promise<Offer[]> {
    if (!query.text) return [];
    const offers = await cachedSearch(this.deps, this.id, query, () =>
      this.query(query.text ?? "", query.limit),
    );
    return matchingEan(offers, query.ean);
  }

  async getLabel(offer: Offer): Promise<LabelResult> {
    return { label: offer.label ?? null };
  }

  private async query(text: string, limit: number, retried = false): Promise<Offer[]> {
    const creds = await this.credentials(retried);
    try {
      const res = await this.deps.http.postJson<{ hits?: Hit[] }>(
        `https://${creds.appId}-dsn.algolia.net/1/indexes/${INDEX}/query`,
        { query: text, hitsPerPage: limit },
        { headers: { "x-algolia-application-id": creds.appId, "x-algolia-api-key": creds.apiKey } },
      );
      return (res.body.hits ?? []).map(parseLaFourcheHit).filter((o): o is Offer => o !== null);
    } catch (error) {
      if (!retried && error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        return this.query(text, limit, true);
      }
      throw error;
    }
  }

  private async credentials(refresh: boolean): Promise<AlgoliaCredentials> {
    if (refresh) this.deps.cache.set("token", "lafourche", null, 0);
    const { value } = await this.deps.cache.wrap<AlgoliaCredentials>(
      "token",
      "lafourche",
      TTL.token,
      async () => {
        const res = await this.deps.http.getText(HOME_URL);
        return extractAlgoliaCredentials(res.body);
      },
    );
    if (!value) throw new Error("La Fourche search credentials not found on the homepage");
    return value;
  }
}
