import { describe, expect, it } from "vitest";
import type { Offer, SourceId, Tier } from "../../src/domain/types.ts";
import { groupOffers, isUnambiguous, rankGroups } from "../../src/engine/identity.ts";

const tierOf = (s: SourceId): Tier => (s === "off" || s === "lafourche" ? "A" : s === "biocoop" ? "B" : "C");

function offer(source: SourceId, name: string, extra: Partial<Offer> = {}): Offer {
  return {
    source,
    sourceProductId: `${source}:${name}`,
    url: null,
    name,
    brand: null,
    ean: null,
    sizeText: null,
    priceEur: null,
    unitPriceText: null,
    inStock: null,
    ...extra,
  };
}

describe("identity", () => {
  it("groups by barcode across sources", () => {
    const groups = groupOffers(
      [
        offer("naturalia", "Muesli Sportif 350g Bio", { ean: "3760372130602" }),
        offer("labellevie", "Muesli gourmand sportif BIO", { ean: "3760372130602", brand: "SuperNature" }),
        offer("off", "Muesli sportif", { ean: "3760372130602", brand: "SuperNature" }),
      ],
      tierOf,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      ref: "ean:3760372130602",
      match: "ean",
      brand: "SuperNature",
      name: "Muesli sportif",
    });
  });

  it("joins offers without barcode only on brand + size + name", () => {
    const groups = groupOffers(
      [
        offer("labellevie", "Pur jus d'orange blonde", { brand: "Frichti", sizeText: "25 cl" }),
        offer("off", "Pur jus d'orange blonde", {
          brand: "Frichti",
          sizeText: "250 ml",
          ean: "3701525000496",
        }),
        offer("naturalia", "Pur jus d'orange 25Cl Bio", { brand: "Naturalia" }),
      ],
      tierOf,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ match: "name_brand_size", ean: "3701525000496" });
    expect(groups[1]?.offers[0]?.source).toBe("naturalia");
  });

  it("never merges other brands of the same product type", () => {
    const groups = groupOffers(
      [
        offer("naturalia", "Yaourt Nature 4x125g Bio", { brand: "Naturalia" }),
        offer("labellevie", "Yaourt nature BIO", { brand: "U", sizeText: "4 x 125 g" }),
      ],
      tierOf,
    );
    expect(groups).toHaveLength(2);
  });

  it("ranks by name, brand and coverage and detects ambiguity", () => {
    const groups = groupOffers(
      [
        offer("naturalia", "Pain Intégral Montignac 1kg Bio", { brand: "Montignac", ean: "3760109052641" }),
        offer("labellevie", "Pain intégral Montignac BIO", { brand: "Montignac", ean: "3760109052641" }),
        offer("biocoop", "Pain de mie complet", { brand: "Biocoop", ean: "3760000000017" }),
      ],
      tierOf,
    );
    const ranked = rankGroups(groups, { query: "pain intégral montignac" });
    expect(ranked[0]?.ean).toBe("3760109052641");
    expect(isUnambiguous(ranked)).toBe(true);
    expect(isUnambiguous(rankGroups(groups, { query: "pain" }))).toBe(false);
  });
});
