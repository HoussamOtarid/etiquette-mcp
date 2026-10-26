import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { Cache } from "../../src/infra/cache.ts";
import { HttpClient } from "../../src/infra/http.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import { parseBiocoopProduct, parseBiocoopSuggest } from "../../src/sources/biocoop.ts";
import { parseChronodriveSearch } from "../../src/sources/chronodrive.ts";
import {
  parseLaBelleVieProduct,
  parseLaBelleVieSearch,
  splitSellingName,
} from "../../src/sources/laBelleVie.ts";
import { parseLaVieClaireProduct, parseLaVieClaireSearch } from "../../src/sources/laVieClaire.ts";
import { parseNaturaliaProduct, parseNaturaliaSuggest } from "../../src/sources/naturalia.ts";
import {
  PicardAdapter,
  parsePicardProduct,
  parsePicardSearch,
  picardProductUrl,
} from "../../src/sources/picard.ts";

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
  it("reads search results with their labels from the page data, once each, with every barcode", () => {
    const html = text("chronodrive/search-muesli.html");
    const offers = parseChronodriveSearch(html);
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({
      source: "chronodrive",
      sourceProductId: "280942",
      name: "Muesli croustillant quinoa chocolat bio",
      brand: "AUCHAN",
      ean: "3596710494132",
      inStock: true,
    });
    expect(offers[0]?.url).toMatch(/^https:\/\/www\.chronodrive\.com\/.+-P280942$/);
    expect(nums(offers[0]?.label?.values ?? {})).toEqual({
      energy_kj: 1838,
      energy_kcal: 437,
      fat_g: 13,
      saturated_fat_g: 5.3,
      carbohydrates_g: 66,
      sugars_g: 22,
      fiber_g: 7.2,
      protein_g: 9.4,
      salt_g: 0.06,
    });
    expect(offers[0]?.label).toMatchObject({
      basis: "100g",
      nutriscore: "C",
      allergens: "Avoine, Blé, Epeautre, Lait",
      traces: expect.stringMatching(/^Amandes, Arachides, .*Soja$/),
      dataOrigin: "store",
    });
    expect(offers[1]?.label?.basis).toBe("100g");
    expect(offers[1]?.label?.values.energy_kj?.value).toBe(1861);
    expect(parseChronodriveSearch(html, "3596710548866")[1]?.ean).toBe("3596710548866");
    expect(() => parseChronodriveSearch("<html></html>")).toThrow(/payload/);
  });
});

describe("Picard", () => {
  const RIZ =
    "https://www.picard.fr/produits/riz-cuisine-espagnole-poivrons-petits-pois-000000000000059697.html";

  it("reads search tiles: Picard's own products, its ranges and other brands", () => {
    const offers = parsePicardSearch(text("picard/search-lasagne.html"));
    expect(offers.map((o) => [o.name, o.brand, o.sizeText, o.priceEur])).toEqual([
      ["Lasagnes bolognaise individuel", "Formule Express (Express Menu)", "barquette de 400 g", 3.65],
      ["Lasagnes à la bolognaise", "Picard", "la boîte de 1 kg", 5.49],
      ["Lasagnes alla bolognese", "Picard", "barquette de 400 g", 4.99],
    ]);
    expect(offers[1]?.url).toBe("https://www.picard.fr/produits/lasagnes-bolognaise-000000000000023532.html");
  });

  it("reads the label per 100 g, the portion, ingredients, allergens, traces and the barcode", () => {
    const page = parsePicardProduct(text("picard/product-riz-espagnole.html"), RIZ);
    expect(page).toMatchObject({ ean: "3270160596973", sizeText: "le sachet de 450 g", priceEur: 3.3 });
    expect(page?.name).toBe("Riz cuisiné à l'espagnole (poivrons, petits pois)");
    const label = page?.label;
    expect(nums(label?.values ?? {})).toEqual({
      energy_kj: 491,
      energy_kcal: 117,
      fat_g: 3.7,
      saturated_fat_g: 0.4,
      carbohydrates_g: 18,
      sugars_g: 1.6,
      fiber_g: 1.5,
      protein_g: 2.5,
      salt_g: 0.54,
    });
    expect(label).toMatchObject({
      basis: "100g",
      portion: { description: "une portion de 150g", amount: 150, unit: "g" },
      nutriscore: "B",
      allergens: "crustacés, poissons",
      parseStatus: "ok",
    });
    expect(label?.raw).toMatch(/Pour une portion de 150g : Energie : 737 kJ 176 kcal/);
    expect(nums(label?.portion?.values ?? {})).toMatchObject({ energy_kcal: 176, fat_g: 5.6, salt_g: 0.81 });
    expect(label?.ingredients).toMatch(/^Riz précuit 54,8%/);
    expect(label?.traces).toMatch(/^Céréales contenant du gluten/);
    expect(parsePicardProduct(text("picard/product-magnum.html"), RIZ.replace("059697", "084354"))?.ean).toBe(
      "8711327608665",
    );
    expect(parsePicardProduct("<html></html>", "https://www.picard.fr/rayons/plats-cuisines")).toBeNull();
    const twoBarcodes = '<meta itemprop="gtin13" content="3270160833900 8000881003673" />';
    expect(parsePicardProduct(twoBarcodes, RIZ)?.ean).toBe("3270160833900");
  });

  it("finds the products Picard makes by barcode, without a request for other barcodes", async () => {
    expect(picardProductUrl("3270160596973")).toMatch(/Product-Show\?pid=000000000000059697$/);
    expect(picardProductUrl("8711327608665")).toBeNull();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("pid=000000000000059697")) {
        const res = new Response(text("picard/product-riz-espagnole.html"));
        Object.defineProperty(res, "url", { value: RIZ });
        return res;
      }
      const gone = new Response("<html></html>");
      Object.defineProperty(gone, "url", { value: "https://www.picard.fr/rayons/plats-cuisines" });
      return gone;
    });
    vi.stubGlobal("fetch", fetchMock);
    const picard = new PicardAdapter({
      http: new HttpClient({
        userAgent: "t",
        timeoutMs: 1000,
        defaultLimit: { intervalMs: 0, concurrency: 4 },
        logger: silentLogger,
      }),
      cache: new Cache(":memory:"),
      logger: silentLogger,
      config: loadConfig({ MCP_AUTH_TOKEN: "t".repeat(32) }),
    });
    const [offer] = await picard.search({ ean: "3270160596973", limit: 1 });
    expect(offer).toMatchObject({ source: "picard", brand: "Picard", ean: "3270160596973", url: RIZ });
    expect(offer?.label?.values.energy_kcal?.value).toBe(117);
    expect(offer && picard.ownsProduct(offer)).toBe(true);
    expect(picard.ownsProduct({ ...(offer as NonNullable<typeof offer>), ean: "8711327608665" })).toBe(false);
    expect(await picard.search({ ean: "8711327608665", limit: 1 })).toEqual([]);
    expect(await picard.search({ ean: "3270160101351", limit: 1 })).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  afterEach(() => vi.unstubAllGlobals());
});
