import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { parseKazidomiProduct } from "../../src/sources/kazidomi.ts";
import { KazidomiIndex, parseSitemap } from "../../src/sources/kazidomiIndex.ts";
import { extractAlgoliaCredentials, parseLaFourcheHit } from "../../src/sources/laFourche.ts";
import { PRODUCT_URL, parseOffProduct, parseOffSearch } from "../../src/sources/openFoodFacts.ts";
import { HOST_LIMITS } from "../../src/sources/registry.ts";

const text = (path: string) => readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8");
const json = <T>(path: string) => JSON.parse(text(path)) as T;
const nums = (values: Record<string, { value: number } | undefined>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v?.value]));

describe("Open Food Facts", () => {
  it("parses a product with its label and data origin", () => {
    const body = json<{ product: Parameters<typeof parseOffProduct>[0] }>("off/product-3760109052641.json");
    const offer = parseOffProduct(body.product);
    expect(offer).toMatchObject({ source: "off", ean: "3760109052641" });
    expect(offer?.label?.values.energy_kcal?.value).toBeGreaterThan(200);
    expect(offer?.label?.basis).toBe("100g");
    expect(["producer", "crowd"]).toContain(offer?.label?.dataOrigin);
  });

  it("reads the v3.6 nutrition structure: basis, qualifiers, no estimates", () => {
    const body = json<{ product: Parameters<typeof parseOffProduct>[0] }>(
      "off/product-v3.6-3596710463411.json",
    );
    const offer = parseOffProduct(body.product);
    expect(offer?.label?.basis).toBe("100g");
    expect(offer?.label?.values).toEqual({
      energy_kcal: { value: 125 },
      energy_kj: { value: 525 },
      fat_g: { value: 5 },
      saturated_fat_g: { value: 2.2 },
      carbohydrates_g: { value: 0.5, qualifier: "lt" },
      sugars_g: { value: 0.5, qualifier: "lt" },
      fiber_g: { value: 0.5, qualifier: "lt" },
      protein_g: { value: 20 },
      salt_g: { value: 0.22 },
    });
  });

  it("skips estimated and prepared values, converts units and falls back to legacy nutriments", () => {
    const set = (extra: Record<string, unknown>, nutrients: Record<string, unknown>) => ({
      code: "4000000000006",
      product_name: "P",
      quantity: "1 L",
      nutrition: { aggregated_set: { per: "100ml", preparation: "as_sold", ...extra, nutrients } },
    });
    const drink = parseOffProduct(
      set(
        {},
        {
          "energy-kcal": { value: 40, unit: "kcal", source: "packaging" },
          proteins: { value: 1, unit: "g", source: "estimate" },
          sodium: { value: 200, unit: "mg", source: "packaging" },
        },
      ) as Parameters<typeof parseOffProduct>[0],
    );
    expect(drink?.label?.basis).toBe("100ml");
    const defaulted = parseOffProduct(
      set({ per: "100g" }, { "energy-kcal": { value: 40, unit: "kcal" } }) as Parameters<
        typeof parseOffProduct
      >[0],
    );
    expect(defaulted?.label?.basis).toBe("100ml");
    expect(drink?.label?.values).toEqual({ energy_kcal: { value: 40 } });
    expect(drink?.label?.sodiumG).toBe(0.2);
    const prepared = parseOffProduct(
      set({ preparation: "prepared" }, { "energy-kcal": { value: 90, unit: "kcal" } }) as Parameters<
        typeof parseOffProduct
      >[0],
    );
    expect(prepared?.label?.values).toEqual({});
    const legacy = parseOffProduct({
      code: "4000000000006",
      product_name: "P",
      nutriments: { "energy-kcal_100g": 55 },
    });
    expect(legacy?.label?.values.energy_kcal).toEqual({ value: 55 });
  });

  it("reports the language of the ingredients, French first", () => {
    const base = {
      code: "4014500519166",
      product_name: "Protein Pudding",
      nutriments: { "energy-kcal_100g": 74 },
    };
    const czech = parseOffProduct({
      ...base,
      ingredients_text: "mléčné bílkoviny, mléko",
      ingredients_lc: "cs",
      lang: "de",
    });
    expect(czech?.label).toMatchObject({ ingredients: "mléčné bílkoviny, mléko", ingredientsLang: "cs" });
    const french = parseOffProduct({
      ...base,
      ingredients_text: "milk",
      ingredients_text_fr: "lait",
      ingredients_lc: "en",
    });
    expect(french?.label).toMatchObject({ ingredients: "lait", ingredientsLang: "fr" });
  });

  it("parses name search hits", () => {
    const offers = parseOffSearch(json("off/search-coquillettes-prix-mini.json"));
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.ean && /^\d{13}$/.test(o.ean))).toBe(true);
    expect(parseOffSearch(json("off/search-empty.json"))).toEqual([]);
  });
});

describe("La Fourche", () => {
  it("finds the public search credentials in the page data", () => {
    expect(extractAlgoliaCredentials(text("lafourche/home-snippet.html"))).toEqual({
      appId: "TESTAPP123",
      apiKey: expect.stringMatching(/^[a-f0-9]{32}$/),
    });
  });

  it("parses hits with the nutrition table, barcode and price", () => {
    const hit = json<{ hits: Array<Parameters<typeof parseLaFourcheHit>[0]> }>(
      "lafourche/algolia-boisson-avoine.json",
    ).hits[0];
    const offer = hit ? parseLaFourcheHit(hit) : null;
    expect(offer).toMatchObject({
      source: "lafourche",
      ean: "3760324840986",
      priceEur: 1.39,
      brand: "La Fourche",
    });
    expect(offer?.url).toBe("https://lafourche.fr/products/la-fourche-boisson-avoine-bio-1l");
    expect(nums(offer?.label?.values ?? {})).toMatchObject({
      energy_kj: 182,
      energy_kcal: 43,
      fat_g: 1.2,
      salt_g: 0.08,
    });
  });
});

describe("Kazidomi", () => {
  it("parses the product API, flagging zero-as-unknown", () => {
    const offer = parseKazidomiProduct(json("kazidomi/product-367.json"));
    expect(offer).toMatchObject({ ean: "5411788047258", brand: "Lima", sizeText: "1000 ml", priceEur: 2.95 });
    expect(offer?.label).toMatchObject({ basis: "100ml", zeroMeansUnknown: true });
    expect(nums(offer?.label?.values ?? {})).toMatchObject({
      energy_kcal: 42,
      fat_g: 0.8,
      carbohydrates_g: 7.7,
      salt_g: 0.09,
    });
    expect(offer?.label?.ingredients).toMatch(/^Eau , AVOINE/);
  });

  it("indexes the sitemap and searches it locally", () => {
    const products = parseSitemap(text("kazidomi/sitemap-sample.xml"));
    expect(products.find((p) => p.id === 367)).toMatchObject({
      brand: "lima",
      name: expect.stringContaining("avoine"),
    });
    const index = new KazidomiIndex(new DatabaseSync(":memory:"));
    index.replaceAll(products);
    expect(index.search("boisson avoine", undefined, 5)[0]?.id).toBe(367);
    expect(index.search("boisson", "Lima", 5).map((p) => p.id)).toEqual(expect.arrayContaining([367, 405]));
    index.rememberEan("5411788047258", 367);
    expect(index.idForEan("5411788047258")).toBe(367);
    expect(index.isStale()).toBe(false);
  });
});

describe("Open Food Facts pacing", () => {
  it("applies the product-read quota to the product endpoint in use", () => {
    const path = `${PRODUCT_URL}/3017620422003`.replace(/^https:\/\//, "");
    const key = Object.keys(HOST_LIMITS).find((k) => path.startsWith(k));
    expect(key && HOST_LIMITS[key as keyof typeof HOST_LIMITS]).toEqual({ intervalMs: 4200, concurrency: 1 });
  });
});
