import { describe, expect, it } from "vitest";
import { isInternalCode, looksLikeBarcode, normalizeEan, usableEan } from "../../src/domain/ean.ts";
import { parseNumber, parseNutrientAmount } from "../../src/domain/numbers.ts";
import { parseQuantity, sameQuantity } from "../../src/domain/quantity.ts";
import { brandSlug, nameTokens, sameBrand, tokenSimilarity } from "../../src/domain/text.ts";

describe("ean", () => {
  it("validates check digits", () => {
    expect(normalizeEan("3760109052641")).toBe("3760109052641");
    expect(normalizeEan("3760109052642")).toBeNull();
    expect(normalizeEan("abc")).toBeNull();
  });

  it("canonicalises UPC-A and GTIN-14", () => {
    expect(normalizeEan("036000291452")).toBe("0036000291452");
    expect(normalizeEan("03760109052641")).toBe("3760109052641");
  });

  it("rejects store-internal codes as join keys", () => {
    expect(isInternalCode("9000000011381")).toBe(true);
    expect(usableEan("9000000011381")).toBeNull();
    expect(usableEan("3256224221302")).toBe("3256224221302");
  });

  it("detects barcode-only queries", () => {
    expect(looksLikeBarcode(" 3760109052641 ")).toBe(true);
    expect(looksLikeBarcode("muesli 350")).toBe(false);
  });
});

describe("numbers", () => {
  it("parses French decimals and thousands separators", () => {
    expect(parseNumber("4,7 g")).toBe(4.7);
    expect(parseNumber("1 121 kj")).toBe(1121);
    expect(parseNumber("2357,52 kJ")).toBe(2357.52);
    expect(parseNumber("none")).toBeNull();
  });

  it("parses qualifiers", () => {
    expect(parseNutrientAmount("<0,5 g")).toEqual({ value: 0.5, qualifier: "lt" });
    expect(parseNutrientAmount("Traces")).toEqual({ value: 0, qualifier: "traces" });
    expect(parseNutrientAmount("?")).toBeNull();
  });
});

describe("quantity", () => {
  it("handles multipacks, units and decimals", () => {
    expect(parseQuantity("Yaourts nature, U (4 x 125 g)")).toEqual({ amount: 500, unit: "g" });
    expect(parseQuantity("Muesli Sportif 350g Bio")).toEqual({ amount: 350, unit: "g" });
    expect(parseQuantity("1,5 L")).toEqual({ amount: 1500, unit: "ml" });
    expect(parseQuantity("Pur jus 25Cl")).toEqual({ amount: 250, unit: "ml" });
    expect(parseQuantity("sans taille")).toBeNull();
  });

  it("compares pack sizes with tolerance", () => {
    expect(sameQuantity({ amount: 370, unit: "g" }, { amount: 360, unit: "g" })).toBe(true);
    expect(sameQuantity({ amount: 500, unit: "g" }, { amount: 200, unit: "g" })).toBe(false);
    expect(sameQuantity({ amount: 1000, unit: "ml" }, { amount: 1000, unit: "g" })).toBeNull();
  });
});

describe("text", () => {
  it("tokenises product names", () => {
    expect(nameTokens("Pâtes Ruban Petit épeautre 250g Bio")).toEqual([
      "pates",
      "ruban",
      "petit",
      "epeautre",
    ]);
  });

  it("matches across plurals, gender, accents, word order and small typos", () => {
    expect(tokenSimilarity("Spaghetti complets", "spaghettis complètes")).toBe(1);
    expect(tokenSimilarity("Céréales muesli", "muesli cereales")).toBe(1);
    expect(tokenSimilarity("musli croustillant", "Muesli croustillant")).toBe(1);
    expect(tokenSimilarity("Spaghetti complets", "Spaghetti demi complètes")).toBeGreaterThan(0.6);
  });

  it("scores name similarity", () => {
    expect(tokenSimilarity("Tomme 3 laits 130g Bio", "Tomme 3 Laits 130g Bio")).toBe(1);
    expect(tokenSimilarity("Compote de fraises", "Compote abricot")).toBeLessThan(0.5);
  });

  it("compares brands", () => {
    expect(brandSlug("Côteaux Nantais")).toBe("coteaux-nantais");
    expect(sameBrand("U", "U Bio")).toBe(true);
    expect(sameBrand("Naturalia", "Biocoop")).toBe(false);
    expect(sameBrand(null, "Biocoop")).toBeNull();
  });
});
