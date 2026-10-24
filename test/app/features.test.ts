import { afterEach, describe, expect, it, vi } from "vitest";
import { NutritionService } from "../../src/app/nutritionService.ts";
import { displayValue, readyToApply } from "../../src/app/present.ts";
import { rankByPrice, spreadOf } from "../../src/app/prices.ts";
import { loadConfig } from "../../src/config.ts";
import type { Offer, SourceId, SourceLabel, Tier } from "../../src/domain/types.ts";
import { decideLabel } from "../../src/engine/decide.ts";
import { Cache } from "../../src/infra/cache.ts";
import { HealthTracker } from "../../src/infra/health.ts";
import { HttpClient } from "../../src/infra/http.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import type { SearchQuery, SourceAdapter } from "../../src/sources/adapter.ts";
import { OpenFoodFactsAdapter } from "../../src/sources/openFoodFacts.ts";
import { REPOSITORY_URL } from "../../src/version.ts";

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
    fetchedAt: "2026-10-24T00:00:00Z",
  };
}

function offer(source: SourceId, name: string, extra: Partial<Offer> = {}): Offer {
  return {
    source,
    sourceProductId: `${source}-${name}-${extra.ean ?? ""}`,
    url: null,
    name,
    brand: null,
    ean: null,
    sizeText: null,
    priceEur: null,
    inStock: true,
    ...extra,
  };
}

function fake(id: SourceId, tier: Tier, search: (q: SearchQuery) => Offer[], ean = false): SourceAdapter {
  return {
    id,
    tier,
    displayName: id,
    capabilities: { text: true, ean },
    search: async (q) => search(q),
    getLabel: async (o) => ({ label: o.label ?? null }),
  };
}

const config = (extra: Record<string, string> = {}) =>
  loadConfig({
    MCP_AUTH_TOKEN: "t".repeat(32),
    REQUEST_BUDGET_MS: "2000",
    SOURCE_TIMEOUT_MS: "1000",
    ...extra,
  });
const service = (adapters: SourceAdapter[]) =>
  new NutritionService(adapters, {
    cache: new Cache(":memory:"),
    health: new HealthTracker(),
    config: config(),
    logger: silentLogger,
  });

describe("prices", () => {
  it("ranks offers by total price and computes the spread", () => {
    const ranked = rankByPrice([
      offer("naturalia", "Lait 1L", { priceEur: 2.99 }),
      offer("lafourche", "Lait 1L", { priceEur: 1.8 }),
      offer("off", "Lait", { priceEur: null }),
      offer("biocoop", "Lait", { priceEur: 2.2 }),
    ]);
    expect(ranked.map((o) => o.source)).toEqual(["lafourche", "biocoop", "naturalia"]);
    expect(spreadOf(ranked)).toEqual({ cheapest: 1.8, most_expensive: 2.99, savings_pct: 39.8 });
    expect(spreadOf(ranked.slice(0, 1))).toBeNull();
  });
});

describe("presentation", () => {
  it("rounds values as labels print them and flattens a ready-to-apply label", () => {
    expect(displayValue("energy_kcal", 76.2428298159)).toBe(76);
    expect(displayValue("protein_g", 5.100000001)).toBe(5.1);
    const d = decideLabel({
      labels: [
        {
          ...label("off", 76.24, 1.4, 5.1, 10),
          values: { ...label("off", 76.24, 1.4, 5.1, 10).values, salt_g: { value: 0.2 } },
        },
      ],
      productName: "Protein pudding",
      tierOf: () => "A",
    });
    const ready = readyToApply(d, { amount: 200, unit: "g" });
    expect(ready.per_100).toMatchObject({ energy_kcal: 76, protein_g: 10, salt_g: 0.2, sodium_g: 0.08 });
    expect(ready.per_pack).toMatchObject({ energy_kcal: 152, protein_g: 20, sodium_g: 0.16 });
    expect(readyToApply(d, { amount: 500, unit: "ml" }).per_pack).toBeNull();
  });

  it("lists nutrients the sources disagree on instead of guessing them", () => {
    const d = decideLabel({
      labels: [label("biocoop", 480, 20, 66, 6), label("naturalia", 480, 20, 66, 6)].map((l, i) => ({
        ...l,
        values: { ...l.values, saturated_fat_g: { value: i === 0 ? 2 : 0 } },
      })),
      productName: "Pétales paprika fumé",
      tierOf: (s) => (s === "biocoop" ? "B" : "C"),
    });
    const ready = readyToApply(d, null);
    expect(ready.per_100.saturated_fat_g).toBeNull();
    expect(ready.conflicts).toEqual([
      {
        nutrient: "saturated_fat_g",
        values: [
          { source: "biocoop", value: 2 },
          { source: "naturalia", value: 0 },
        ],
        best_guess: 2,
      },
    ]);
    expect(ready.per_100.energy_kcal).toBe(480);
  });
});

describe("service features", () => {
  const yogurts = (): SourceAdapter => ({
    id: "lafourche",
    tier: "A",
    displayName: "lafourche",
    capabilities: { text: true, ean: false },
    search: async () => [
      offer("lafourche", "Yaourt nature brebis 4x125g", { brand: "Y" }),
      offer("lafourche", "Yaourt nature vache 4x125g", { brand: "Y" }),
    ],
    getLabel: async (o) => ({
      label: o.name.includes("brebis")
        ? label("lafourche", 95, 6, 4.5, 5.2)
        : label("lafourche", 60, 3.4, 4.6, 3.3),
    }),
  });

  it("previews the label of every candidate", async () => {
    const ambiguous = await service([yogurts()]).getLabel({ product: "yaourt nature" });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.candidates?.map((c) => c.label_preview?.energy_kcal)).toEqual([95, 60]);
  });

  it("treats pack sizes sharing a label as one product", async () => {
    const ricotta = fake("naturalia", "C", () => [
      offer("naturalia", "Ricotta Italiana 250g", {
        brand: "Zanetti",
        ean: "8002710333111",
        label: label("naturalia", 143, 11, 2.5, 8.5),
      }),
      offer("naturalia", "Ricotta Italiana 1,5kg", {
        brand: "Zanetti",
        ean: "8002710333104",
        label: { ...label("naturalia", 143, 11, 2.5, 8.5), basis: "100g/100ml" },
      }),
    ]);
    const result = await service([ricotta]).getLabel({ product: "ricotta italiana", brand: "Zanetti" });
    expect(result.status).toBe("found");
    expect(result.product?.other_sizes).toEqual([{ product_ref: "ean:8002710333104", size: "1500 g" }]);
    expect(result.notes.some((n) => n.includes("several pack sizes with the same label"))).toBe(true);
  });

  it("takes per-item brands in get_labels and returns compact results by default", async () => {
    const result = await service([yogurts()]).getLabels({
      products: [{ product: "yaourt nature vache", brand: "Y" }],
    });
    const [first] = result.results;
    expect(first).toMatchObject({ input: "yaourt nature vache", status: "found" });
    expect(first?.product).toMatchObject({ name: "Yaourt nature vache 4x125g", stores: ["lafourche"] });
    expect(first?.product?.offers).toBeUndefined();
    expect(first?.offers).toBeUndefined();
    expect(first?.per_source).toBeUndefined();
    expect(first?.ready_to_apply?.per_100.energy_kcal).toBe(60);
  });

  it("notes a brand mismatch on a found product and shows scores from 0 to 1", async () => {
    const shop = fake("labellevie", "C", () => [
      offer("labellevie", "Steak haché pur bœuf 5%", {
        ean: "3760099537883",
        label: label("labellevie", 125, 5, 0, 21),
      }),
    ]);
    const svc = service([shop]);
    const found = await svc.getLabel({ product: "steak haché pur bœuf 5%", brand: "Bonval" });
    expect(found.status).toBe("found");
    expect(found.notes).toContain("The product found has no brand listed; Bonval could not be confirmed.");
    const search = await svc.findProduct({ query: "steak haché pur bœuf 5%" });
    expect(search.products[0]?.score).toBeLessThanOrEqual(1);
  });

  it("flags a missing brand and weak matches", async () => {
    const shop = fake("naturalia", "C", () => [
      offer("naturalia", "Chocolat noir à l'orange", { brand: "Côte d'Or", ean: "7622210000001" }),
    ]);
    const result = await service([shop]).findProduct({
      query: "jus d'orange pressée",
      brand: "Alain Milliat",
    });
    expect(result).toMatchObject({ no_good_match: true, requested_brand_found: false });
    expect(result.notes).toContain(
      "No product of brand Alain Milliat was found; the results are other brands.",
    );
  });

  it("uses a brand written in the query and drops unrelated products", async () => {
    const shops = fake("labellevie", "C", () => [
      offer("labellevie", "Steak haché pur bœuf 5%", { brand: "Bonval", ean: "3760099539001" }),
      offer("labellevie", "Oeufs frais BIO", { brand: "Bonval", ean: "3760099536978" }),
      offer("labellevie", "10 steaks hachés pur bœuf 5%", { brand: "Toupargel", ean: "3273230252144" }),
    ]);
    const result = await service([shops]).findProduct({ query: "Bonval bœuf haché 5%" });
    expect(result.products.map((p) => p.name)).toEqual(["Steak haché pur bœuf 5%"]);
    expect(result.notes).toContain("Brand taken from the query: Bonval.");
  });

  it("keeps the requested brand, scores products and previews known labels", async () => {
    const shops = fake("lafourche", "A", () => [
      offer("lafourche", "Biscuits pois gourmands citron", {
        brand: "Greendoz",
        ean: "3701283800444",
        label: label("lafourche", 452, 19.6, 53.3, 8),
      }),
      offer("lafourche", "Biscuits apéritif citron", { brand: "Autre", ean: "3701283800000" }),
    ]);
    const result = await service([shops]).findProduct({
      query: "Biscuits Greendoz Pois Citron",
      brand: "Greendoz",
    });
    expect(result.products.map((p) => p.brand)).toEqual(["Greendoz"]);
    expect(result.products[0]?.score).toBeGreaterThan(0.3);
    expect(result.products[0]?.label_preview).toMatchObject({
      source: "lafourche",
      energy_kcal: 452,
      fat_g: 19.6,
    });
  });

  it("asks Open Food Facts by name when no shop result has the brand", async () => {
    const shops = fake("naturalia", "C", () => [
      offer("naturalia", "Citrons bio", { brand: "Naturalia", ean: "3700000000001" }),
    ]);
    const offSearch = vi.fn(() => [
      offer("off", "Sorbet citron", { brand: "Häagen-Dazs", ean: "3415581101010" }),
    ]);
    const off = fake("off", "A", offSearch, true);
    const result = await service([shops, off]).findProduct({ query: "Sorbet citron", brand: "Häagen-Dazs" });
    expect(offSearch).toHaveBeenCalled();
    expect(result.products[0]).toMatchObject({ brand: "Häagen-Dazs", ean: "3415581101010" });
  });

  it("lists other sizes and flavours of the brand as variants", async () => {
    const shop = fake("labellevie", "C", () => [
      offer("labellevie", "Ricotta italiana", {
        brand: "Zanetti",
        sizeText: "250 g",
        ean: "8002710333111",
        label: label("labellevie", 140, 10, 3, 9),
      }),
      offer("labellevie", "Ricotta italiana", { brand: "Zanetti", sizeText: "1500 g", ean: "8002710333005" }),
      offer("labellevie", "Ricotta di bufala", { brand: "Zanetti", sizeText: "250 g", ean: "8002710333222" }),
    ]);
    const result = await service([shop]).getLabel({
      product: "ricotta italiana 250 g zanetti",
      brand: "Zanetti",
    });
    expect(result.status).toBe("found");
    expect(result.product?.ean).toBe("8002710333111");
    expect(result.variants?.map((v) => v.ean)).toEqual(expect.arrayContaining(["8002710333005"]));
  });

  it("counts a shop once when it lists the product several times", async () => {
    const shop = fake(
      "labellevie",
      "C",
      (q) =>
        q.ean
          ? [1, 2, 3].map((i) =>
              offer("labellevie", `Kombucha ${i}`, {
                ean: q.ean,
                sourceProductId: `k${i}`,
                label: label("labellevie", 20, 0, 4.8, 0),
              }),
            )
          : [],
      true,
    );
    const result = await service([shop]).getLabel({ product: "3770017807073" });
    expect(result.confidence?.sources_with_label).toBe(1);
    expect(result.confidence?.flags).not.toContain("copied_label_collapsed");
  });

  it("compares total prices of the same product across stores", async () => {
    const ean = "3760324840986";
    const shops = [
      fake("lafourche", "A", () => [
        offer("lafourche", "Boisson avoine 1L", {
          ean,
          brand: "X",
          priceEur: 1.39,
          label: label("lafourche", 43, 1.2, 7.3, 0.6),
        }),
      ]),
      fake("naturalia", "C", () => [
        offer("naturalia", "Boisson avoine 1L", { ean, brand: "X", priceEur: 1.99 }),
        offer("naturalia", "Boisson avoine vanille 1L", { ean: "3760000000102", brand: "Y", priceEur: 1.2 }),
      ]),
    ];
    const svc = service(shops);
    const same = await svc.comparePrices({ product: "boisson avoine 1L", brand: "X" });
    expect(same.status).toBe("found");
    expect(same.offers?.map((o) => [o.source, o.price_eur])).toEqual([
      ["lafourche", 1.39],
      ["naturalia", 1.99],
    ]);
    expect(same.spread?.savings_pct).toBe(30.2);
    expect(same.cheapest?.source).toBe("lafourche");
  });
});

describe("get_labels batching", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads several barcodes once each through the v3.6 queue, in order", async () => {
    const eans = ["3760109052641", "5411788047258", "3760196070214"];
    const fetchMock = vi.fn(async (url: string) => {
      const u = new URL(url);
      const code = u.pathname.split("/").pop() ?? "";
      if (!eans.includes(code))
        return Response.json(
          { code, status: "failure", errors: [{ message: { id: "product_not_found" } }] },
          { status: 404 },
        );
      await new Promise((r) => setTimeout(r, 10));
      return Response.json({
        code,
        status: "success",
        product: {
          code,
          product_name: "P",
          nutrition: {
            aggregated_set: {
              per: "100g",
              nutrients: {
                "energy-kcal": { value: 100, unit: "kcal", source: "packaging" },
                fat: { value: 1, unit: "g", source: "packaging" },
                carbohydrates: { value: 20, unit: "g", source: "packaging" },
                proteins: { value: 3, unit: "g", source: "packaging" },
              },
            },
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const cfg = config();
    const deps = {
      http: new HttpClient({
        userAgent: "t",
        timeoutMs: 1000,
        defaultLimit: { intervalMs: 0, concurrency: 4 },
        logger: silentLogger,
      }),
      cache: new Cache(":memory:"),
      logger: silentLogger,
      config: cfg,
    };
    const svc = new NutritionService([new OpenFoodFactsAdapter(deps)], {
      cache: deps.cache,
      health: new HealthTracker(),
      config: cfg,
      logger: silentLogger,
    });
    const result = await svc.getLabels({ products: [...eans, "ean:4000000000006"] });
    expect(result.results.map((r) => r.input)).toEqual([...eans, "ean:4000000000006"]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers["user-agent"]).toBe(`${cfg.userAgent} (+${REPOSITORY_URL})`);
    expect(result.results.slice(0, 3).every((r) => r.status === "found")).toBe(true);
    expect(result.results[3]?.status).toBe("not_found");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/api/v3.6/product/"))).toBe(true);
  });
});
