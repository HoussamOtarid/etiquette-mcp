import { describe, expect, it } from "vitest";
import { genericFoods, genericFoodsInfo } from "../../src/app/genericFoods.ts";
import { type CiqualFood, searchCiqual } from "../../src/sources/ciqual.ts";

const food = (code: number, name: string, name_en: string): CiqualFood => ({
  code,
  name,
  name_en,
  group: null,
  values: {},
});

const top = (query: string, n = 1) => genericFoods(query, n).foods.map((f) => f.name);

describe("generic foods (Ciqual)", () => {
  it("ranks the food named first, its average entry, the exact words and the percentage asked for", () => {
    const foods = [
      food(1, "Pomme de terre, cuite (aliment moyen)", "Potato, cooked (average)"),
      food(2, "Pomme, sèche", "Apple, dried"),
      food(3, "Pomme, chair sans peau, crue (aliment moyen)", "Apple, flesh without skin, raw (average)"),
      food(4, "Pâte brisée, préemballée, cuite (aliment moyen)", "Short crust pastry, cooked (average)"),
      food(5, "Pâtes sèches, standard, cuites, sans sel ajouté", "Pasta, dry, regular, cooked"),
      food(6, "Boeuf, steak haché 15% MG cru", "Beef, minced steak, 15% fat, raw"),
      food(7, "Boeuf, steak haché 5% MG cru", "Beef, minced steak, 5% fat, raw"),
      food(8, "Olive noire, à l'huile", "Olive, black, in oil"),
      food(9, "Huile d'olive vierge extra", "Olive oil, extra virgin"),
    ];
    const first = (q: string) => searchCiqual(foods, q, 1)[0]?.food.code;
    expect(first("pomme")).toBe(3);
    expect(first("apple")).toBe(3);
    expect(first("pâtes cuites")).toBe(5);
    expect(first("steak haché 5%")).toBe(7);
    expect(first("huile d'olive")).toBe(9);
    expect(searchCiqual(foods, "chocolat", 5)).toEqual([]);
  });

  it("answers from the Ciqual table with values per 100 g, qualifiers and data quality", () => {
    expect(top("banane")).toEqual(["Banane, chair sans peau, crue"]);
    expect(top("banana")).toEqual(["Banane, chair sans peau, crue"]);
    expect(top("riz basmati cuit")).toEqual(["Riz basmati, cuit, sans sel ajouté"]);
    const [banana] = genericFoods("banane", 1).foods;
    expect(banana).toMatchObject({
      basis: "100g",
      per_100: { energy_kcal: 88, carbohydrates_g: 19.7, protein_g: 1.06, sodium_g: 0.005 },
      qualifiers: { fat_g: "lt" },
      data_quality: "A",
    });
    expect(banana?.score).toBeLessThanOrEqual(1);
    const none = genericFoods("zzzz");
    expect(none.foods).toEqual([]);
    expect(none.advice).toMatch(/No food/);
    expect(genericFoodsInfo().foods).toBeGreaterThan(3000);
  });
});
