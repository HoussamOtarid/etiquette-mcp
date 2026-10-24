import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBiocoopProduct, parseBiocoopSuggest } from "../../src/sources/biocoop.ts";
import {
  hasProductDetails,
  parseChronodriveProduct,
  parseChronodriveSearch,
} from "../../src/sources/chronodrive.ts";
import {
  parseLaBelleVieProduct,
  parseLaBelleVieSearch,
  splitSellingName,
} from "../../src/sources/laBelleVie.ts";
import { parseLaVieClaireProduct, parseLaVieClaireSearch } from "../../src/sources/laVieClaire.ts";
import { parseNaturaliaProduct, parseNaturaliaSuggest } from "../../src/sources/naturalia.ts";

const text = (path: string) => readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8");
const json = <T>(path: string) => JSON.parse(text(path)) as T;
const nums = (values: Record<string, { value: number } | undefined>) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v?.value]));

describe("Biocoop", () => {
  it("parses search results with barcodes and prices", () => {
    const offers = parseBiocoopSuggest(json("biocoop/suggest-boisson-avoine.json"));
    expect(offers.length).toBeGreaterThan(0);
    expect(offers[0]).toMatchObject({
      source: "biocoop",
      priceEur: expect.any(Number),
      ean: expect.stringMatching(/^\d{13}$/),
    });
  });

  it("parses the product page label, composition and allergens", () => {
    const { label } = parseBiocoopProduct(
      text("biocoop/product-boisson-avoine.html"),
      "https://www.biocoop.fr/x.html",
    );
    expect(label.basis).toBe("100g/100ml");
    expect(nums(label.values)).toEqual({
      energy_kj: 186,
      energy_kcal: 44,
      fat_g: 1.4,
      saturated_fat_g: 0.2,
      carbohydrates_g: 7.1,
      sugars_g: 4.7,
      protein_g: 0.8,
      salt_g: 0.09,
    });
    expect(label.ingredients).toMatch(/^Eau, AVOINE/);
    expect(label.allergens).toMatch(/gluten/);
    expect(label.traces).toBeNull();
  });
});

describe("La Vie Claire", () => {
  it("parses shop API results with prices in minor units", () => {
    const offers = parseLaVieClaireSearch(json("lavieclaire/store-boisson-avoine.json"));
    expect(offers[0]).toMatchObject({ source: "lavieclaire", priceEur: expect.any(Number), ean: null });
    expect(offers[0]?.priceEur).toBeLessThan(20);
  });

  it("parses the nutrition table and JSON-LD barcode", () => {
    const { label, ean } = parseLaVieClaireProduct(
      text("lavieclaire/product-barre-pistache.html"),
      "https://x",
    );
    expect(ean).toBe("4044889005134");
    expect(label.basis).toBe("100g");
    expect(nums(label.values)).toEqual({
      energy_kj: 2370,
      energy_kcal: 566,
      fat_g: 37,
      saturated_fat_g: 21,
      carbohydrates_g: 49,
      sugars_g: 46,
      protein_g: 9.5,
      salt_g: 0.31,
    });
    expect(label.ingredients).toMatch(/^sucre de canne brun/);
  });
});

describe("Naturalia", () => {
  it("reads barcodes from search image names", () => {
    const offers = parseNaturaliaSuggest(json("naturalia/suggest-pistache.json"));
    expect(offers[0]).toMatchObject({ source: "naturalia", ean: "3700036910362", priceEur: 7.99 });
  });

  it("splits ingredients, free-text label and traces; derives salt from sodium", () => {
    const { label, ean } = parseNaturaliaProduct(
      text("naturalia/product-pistaches-grillees.html"),
      "https://x",
    );
    expect(ean).toBe("3760149995670");
    expect(label.ingredients).toMatch(/^Pistaches biologiques/);
    expect(nums(label.values)).toMatchObject({
      energy_kcal: 564,
      fat_g: 48.6,
      saturated_fat_g: 6.16,
      protein_g: 20.95,
    });
    expect(label.sodiumG).toBe(0.78);
    expect(label.traces).toMatch(/gluten/);
  });
});

describe("La Belle Vie", () => {
  it("splits selling names into name, brand and size", () => {
    expect(splitSellingName("Yaourts nature, U (4 x 125 g)")).toEqual({
      name: "Yaourts nature",
      brand: "U",
      size: "4 x 125 g",
    });
    expect(splitSellingName("Tomme 3 laits, 55 % MG/PF BIO (130 g)")).toEqual({
      name: "Tomme 3 laits, 55 % MG/PF BIO",
      brand: null,
      size: "130 g",
    });
  });

  it("parses search hits for the configured zone", () => {
    const offers = parseLaBelleVieSearch(json("labellevie/search-yaourt-nature.json"), "1-9");
    expect(offers[0]).toMatchObject({
      source: "labellevie",
      priceEur: expect.any(Number),
      url: expect.stringMatching(/\/produit\/\d+$/),
    });
  });

  it("parses each label layout", () => {
    const parse = (file: string) => parseLaBelleVieProduct(text(`labellevie/${file}`), "https://x").label;
    expect(nums(parse("product-yaourt-u.html").values)).toMatchObject({
      energy_kcal: 43,
      protein_g: 3.8,
      salt_g: 0.12,
    });
    expect(nums(parse("product-cruesli.html").values)).toMatchObject({ energy_kcal: 455, fat_g: 19 });
    expect(nums(parse("product-pizza-treo.html").values)).toMatchObject({ energy_kcal: 268, fat_g: 9.2 });
    expect(nums(parse("product-huile-u.html").values)).toMatchObject({ energy_kcal: 900, fat_g: 100 });
    const butter = parse("product-beurre-frichti.html");
    expect(butter.copiedFrom).toBe("off");
    expect(butter.values.energy_kcal?.value).toBe(743);
  });
});

describe("Chronodrive", () => {
  it("reads search results from the page data, once each, with every barcode", () => {
    const html = text("chronodrive/search-yaourt-nature.html");
    const offers = parseChronodriveSearch(html);
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({
      source: "chronodrive",
      sourceProductId: "167759",
      url: "https://www.chronodrive.com/auchan--yaourts-brasses-nature-P167759",
      name: "Yaourts brassés nature",
      brand: "AUCHAN",
      ean: "3254560270770",
      sizeText: "4 x 125 g",
      priceEur: 0.79,
      inStock: true,
    });
    expect(parseChronodriveSearch(html, "3596710402502")[0]?.ean).toBe("3596710402502");
    expect(() => parseChronodriveSearch("<html></html>")).toThrow(/payload/);
  });

  it("parses the nutrition table, ingredients, allergens and barcode of a product page", () => {
    const url = "https://www.chronodrive.com/activia--yaourts-bifidus-nature-P3953_1";
    const { label, ean } = parseChronodriveProduct(text("chronodrive/product-activia-nature.html"), url);
    expect(ean).toBe("3033491147067");
    expect(label).toMatchObject({ basis: "100g", nutriscore: "B", allergens: "LAIT", dataOrigin: "store" });
    expect(nums(label.values)).toEqual({
      energy_kj: 258,
      energy_kcal: 62,
      fat_g: 3.4,
      saturated_fat_g: 2.2,
      carbohydrates_g: 4.4,
      sugars_g: 4.4,
      protein_g: 3.4,
      salt_g: 0.12,
    });
    expect(label.extra).toContainEqual(expect.objectContaining({ name: "Calcium", value: 119, unit: "mg" }));
    expect(label.ingredients).toMatch(/^LAIT entier \(96%\)/);
    const grams = text("chronodrive/product-activia-nature.html").replace(/pour 100 g/g, "pour 100.000 gr");
    expect(parseChronodriveProduct(grams, url).label.basis).toBe("100g");
    expect(hasProductDetails(text("chronodrive/product-activia-nature.html"))).toBe(true);
    expect(hasProductDetails('<html><body><div id="app"></div></body></html>')).toBe(false);
  });
});
