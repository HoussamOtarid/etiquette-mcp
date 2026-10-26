import { describe, expect, it } from "vitest";
import { NutritionService, withInferredBasis } from "../../src/app/nutritionService.ts";
import { loadConfig } from "../../src/config.ts";
import type { Offer, SourceId, SourceLabel, Tier } from "../../src/domain/types.ts";
import { Cache } from "../../src/infra/cache.ts";
import { HealthTracker } from "../../src/infra/health.ts";
import { RateLimitedError } from "../../src/infra/http.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import type { LabelResult, SearchQuery, SourceAdapter } from "../../src/sources/adapter.ts";

const EAN = "3760109052641";

function label(source: SourceId, kcal: number, fat: number, carbs: number, protein: number): SourceLabel {
  return {
    source,
    basis: "100g",
    values: {
      energy_kcal: { value: kcal },
      fat_g: { value: fat },
      carbohydrates_g: { value: carbs },
      protein_g: { value: protein },
    },
    extra: [],
    raw: null,
    ingredients: null,
    allergens: null,
    traces: null,
    nutriscore: null,
    parseStatus: "partial",
    url: null,
    fetchedAt: "2026-10-23T00:00:00Z",
  };
}

function offer(source: SourceId, name: string, extra: Partial<Offer> = {}): Offer {
  return {
    source,
    sourceProductId: `${source}-${name}`,
    url: `https://${source}.example/${encodeURIComponent(name)}`,
    name,
    brand: "Montignac",
    ean: null,
    sizeText: "1 kg",
    priceEur: 4.99,
    inStock: true,
    ...extra,
  };
}

interface FakeSpec {
  id: SourceId;
  tier: Tier;
  text?: boolean;
  ean?: boolean;
  search: (q: SearchQuery) => Offer[] | Promise<Offer[]>;
  getLabel?: (o: Offer) => LabelResult | Promise<LabelResult>;
}

function fake(spec: FakeSpec): SourceAdapter {
  return {
    id: spec.id,
    tier: spec.tier,
    displayName: spec.id,
    capabilities: { text: spec.text ?? true, ean: spec.ean ?? false },
    search: async (q) => spec.search(q),
    getLabel: async (o) => (spec.getLabel ? spec.getLabel(o) : { label: o.label ?? null }),
  };
}

function service(adapters: SourceAdapter[], overrides: Record<string, string> = {}) {
  const config = loadConfig({
    MCP_AUTH_TOKEN: "t".repeat(32),
    REQUEST_BUDGET_MS: "2000",
    SOURCE_TIMEOUT_MS: "1000",
    ...overrides,
  });
  return new NutritionService(adapters, {
    cache: new Cache(":memory:"),
    health: new HealthTracker(),
    config,
    logger: silentLogger,
  });
}

const off = fake({
  id: "off",
  tier: "A",
  ean: true,
  search: (q) =>
    q.ean === EAN || q.text?.includes("montignac")
      ? [offer("off", "Pain intégral Montignac", { ean: EAN, label: label("off", 230, 1, 44, 6.8) })]
      : [],
});
const naturalia = fake({
  id: "naturalia",
  tier: "C",
  ean: true,
  search: (q) =>
    q.ean === EAN || q.text?.toLowerCase().includes("montignac")
      ? [offer("naturalia", "Pain Intégral Montignac 1kg Bio", { ean: EAN })]
      : [],
  getLabel: () => ({ label: label("naturalia", 230, 1, 44, 6.8), ean: EAN }),
});
const lafourche = fake({
  id: "lafourche",
  tier: "A",
  search: (q) =>
    q.text?.toLowerCase().includes("montignac")
      ? [
          offer("lafourche", "Pain intégral Montignac Bio", {
            ean: EAN,
            label: label("lafourche", 229, 1, 44, 6.8),
          }),
        ]
      : [],
});
const lavieclaire = fake({
  id: "lavieclaire",
  tier: "B",
  search: (q) =>
    q.text?.toLowerCase().includes("montignac") ? [offer("lavieclaire", "Pain intégral Montignac")] : [],
  getLabel: () => ({ label: label("lavieclaire", 230, 1, 44, 6.8), ean: EAN }),
});

describe("NutritionService", () => {
  it("collects a barcode across direct and name-only sources, verifying pages", async () => {
    const result = await service([off, naturalia, lafourche, lavieclaire]).getLabel({ product: EAN });
    expect(result.status).toBe("found");
    expect(result.product).toMatchObject({ ean: EAN, product_ref: `ean:${EAN}` });
    expect(result.offers?.map((o) => o.source).sort()).toEqual([
      "lafourche",
      "lavieclaire",
      "naturalia",
      "off",
    ]);
    expect(result.confidence?.overall).toBe("high");
    expect(result.label?.nutrients.energy_kcal).toMatchObject({
      value: 230,
      agreement: "strong",
      sources_agree: 4,
    });
    expect(result.per_source).toHaveLength(4);
  });

  it("takes the label of the brand's own shop as the reference", async () => {
    const own = {
      ...fake({
        id: "biocoop",
        tier: "B",
        ean: true,
        search: (q) =>
          q.ean === EAN ? [offer("biocoop", "Pain intégral", { ean: EAN, brand: "Biocoop" })] : [],
        getLabel: () => ({
          label: {
            ...label("biocoop", 230, 1, 44, 6.8),
            portion: {
              description: "une portion de 150g",
              amount: 150,
              unit: "g",
              values: { energy_kcal: { value: 344 }, protein_g: { value: 10.2 } },
            },
          },
          ean: EAN,
        }),
      }),
      ownsProduct: (o: Offer) => o.brand === "Biocoop",
    };
    const crowd = fake({
      id: "off",
      tier: "A",
      ean: true,
      search: (q) =>
        q.ean === EAN
          ? [offer("off", "Pain intégral", { ean: EAN, label: label("off", 260, 1, 44, 6.8) })]
          : [],
    });
    const result = await service([crowd, own]).getLabel({ product: EAN });
    expect(result.label?.nutrients.energy_kcal).toMatchObject({ value: 230, agreement: "brand_owner" });
    expect(result.confidence?.overall).toBe("high");
    expect(result.confidence?.flags).toContain("brand_owner_label");
    expect(result.ready_to_apply).toMatchObject({
      portion: { description: "une portion de 150g", amount: 150, unit: "g" },
      per_portion: { energy_kcal: 344, protein_g: 10.2 },
    });
  });

  it("returns candidates when a text query is ambiguous, and labels them by reference", async () => {
    const yaourts = fake({
      id: "biocoop",
      tier: "B",
      search: () => [
        offer("biocoop", "Yaourt nature brebis", { brand: "Biocoop", ean: "3760121215109" }),
        offer("biocoop", "Yaourt nature vache", { brand: "Biocoop", ean: "3375610000816" }),
      ],
      getLabel: () => ({ label: label("biocoop", 72, 3.6, 5.7, 3.4) }),
    });
    const svc = service([yaourts]);
    const ambiguous = await svc.getLabel({ product: "yaourt nature" });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.candidates).toHaveLength(2);
    const ref = ambiguous.candidates?.[0]?.product_ref ?? "";
    const chosen = await svc.getLabel({ product: ref });
    expect(chosen.status).toBe("found");
    expect(chosen.confidence?.overall).toBe("medium");
  });

  it("finds products by text in shops, keeping Open Food Facts name search as a fallback", async () => {
    const result = await service([off, naturalia, lafourche]).findProduct({
      query: "pain intégral montignac",
    });
    expect(result.query_kind).toBe("text");
    expect(result.products[0]).toMatchObject({ ean: EAN, match: "ean" });
    expect(result.products[0]?.offers?.map((o) => o.source).sort()).toEqual(["lafourche", "naturalia"]);
    expect(result.sources.off).toBe("skipped");

    const offOnly = await service([off]).findProduct({ query: "pain intégral montignac" });
    expect(offOnly.products[0]?.offers?.map((o) => o.source)).toEqual(["off"]);
  });

  it("joins offers whose barcode is only on the product page, despite different brand names", async () => {
    const pageOnly = fake({
      id: "naturalia",
      tier: "C",
      ean: true,
      search: (q) =>
        q.text ? [offer("naturalia", "Pain Intégral Montignac 1kg Bio", { brand: "Montignac" })] : [],
      getLabel: () => ({ label: label("naturalia", 230, 1, 44, 6.8), ean: EAN }),
    });
    const maker = fake({
      id: "labellevie",
      tier: "C",
      ean: true,
      search: (q) =>
        q.text
          ? [offer("labellevie", "Pain intégral Montignac BIO, tranché", { brand: "Belledonne", ean: EAN })]
          : [],
    });
    const result = await service([pageOnly, maker]).findProduct({ query: "pain intégral montignac" });
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({ ean: EAN, match: "ean" });
    expect(result.products[0]?.offers?.map((o) => o.source).sort()).toEqual(["labellevie", "naturalia"]);
  });

  it("answers within the budget when a source is slow", async () => {
    const slow = fake({
      id: "biocoop",
      tier: "B",
      ean: true,
      search: () => new Promise<Offer[]>((resolve) => setTimeout(() => resolve([]), 5000)),
    });
    const started = Date.now();
    const result = await service([off, slow], { SOURCE_TIMEOUT_MS: "200" }).getLabel({ product: EAN });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.status).toBe("found");
    expect(result.sources.biocoop).toBe("timeout");
  });

  it("ignores a label whose page shows another barcode", async () => {
    const wrong = fake({
      id: "labellevie",
      tier: "C",
      ean: true,
      search: (q) => (q.ean === EAN ? [offer("labellevie", "Pain intégral Montignac", { ean: EAN })] : []),
      getLabel: () => ({ label: label("labellevie", 300, 5, 50, 9), ean: "3256224221302" }),
    });
    const result = await service([off, wrong]).getLabel({ product: EAN });
    expect(result.per_source?.map((p) => p.source)).toEqual(["off"]);
    expect(result.notes.join(" ")).toMatch(/another barcode/);
  });

  it("reports an incomplete result, not a final one, when sources fail", async () => {
    const limited = fake({
      id: "off",
      tier: "A",
      ean: true,
      search: () => Promise.reject(new RateLimitedError("world.openfoodfacts.org")),
    });
    for (const product of ["3256224221302", "ean:3256224221302"]) {
      const result = await service([limited]).getLabel({ product });
      expect(result).toMatchObject({ status: "incomplete", retry_after_s: 30 });
      expect(result.advice).toMatch(/off \(rate_limited\)/);
      expect(result.advice).not.toMatch(/expired/);
    }
  });

  it("infers a missing basis from the pack unit", () => {
    const unknown = { ...label("labellevie", 3, 0, 0.5, 0), basis: "unknown" as const };
    expect(withInferredBasis(unknown, "Ciao (33 cl)")).toMatchObject({ basis: "100ml", basisInferred: true });
    expect(withInferredBasis(unknown, "sans taille")).toBe(unknown);
    expect(withInferredBasis(label("off", 230, 1, 44, 6.8), "33 cl").basis).toBe("100g");
  });

  it("reports unknown barcodes", async () => {
    const result = await service([off]).getLabel({ product: "3256224221302" });
    expect(result.status).toBe("not_found");
    expect(result.advice).toMatch(/Ask the user/);
  });

  it("lists sources with health", async () => {
    const svc = service([off, naturalia]);
    await svc.getLabel({ product: EAN });
    const sources = svc.listSources();
    expect(sources.map((s) => s.source)).toEqual(["off", "naturalia"]);
    expect(sources[0]).toMatchObject({ search_by_barcode: true, status: "ok" });
  });
});

describe("nameQueries", () => {
  it("tries a short brand + key words query before the full name", async () => {
    const { nameQueries } = await import("../../src/app/nutritionService.ts");
    expect(nameQueries({ name: "Barre chocolat au lait pistache style Dubaï", brand: "Vivani" })).toEqual([
      "Vivani barre chocolat lait",
      "barre chocolat lait",
      "Barre chocolat au lait pistache style Dubaï Vivani",
    ]);
  });
});
