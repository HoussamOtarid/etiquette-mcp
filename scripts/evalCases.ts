/** Real lookups with the product expected, for scripts/eval.ts. Product names only, nothing personal. */

export interface Expected {
  /** Barcode(s) of the expected product. */
  ean?: string | string[];
  /** Words the expected product's name (with its brand) must contain, when there is no barcode. */
  name?: string;
  brand?: string;
}

export interface EvalCase {
  id: string;
  tool: "get_label" | "find_product" | "get_generic_food";
  input: Record<string, unknown>;
  expect: Expected;
  /** Known gap: expected to fail for now, reported apart. */
  gap?: string;
}

const label = (
  id: string,
  product: string | { product: string; brand: string },
  expect: Expected,
  gap?: string,
): EvalCase => ({
  id,
  tool: "get_label",
  input: { ...(typeof product === "string" ? { product } : product), compact: true },
  expect,
  ...(gap ? { gap } : {}),
});

const generic = (id: string, query: string, name: string): EvalCase => ({
  id,
  tool: "get_generic_food",
  input: { query },
  expect: { name },
});

export const CASES: EvalCase[] = [
  // barcodes
  label("ean-bread", "3760109052641", { ean: "3760109052641" }),
  label("ean-cheese", "3760196070214", { ean: "3760196070214" }),
  label("ean-oat-drink", "5411788041157", { ean: "5411788041157" }),
  label("ean-shop-oat-drink", "3760324840986", { ean: "3760324840986" }),
  label("ean-own-brand", "3596710463411", { ean: "3596710463411" }),
  label("ean-zott", "4014500519166", { ean: "4014500519166" }),
  label("ean-gluten-free-oat-drink", "5411788047258", { ean: "5411788047258" }),
  // descriptions
  label("bonval-hache-5", "bonval bœuf haché 5%", { ean: "3760099537883" }),
  label("zott-pudding-caramel", "zott protein pudding caramel", { name: "pudding caramel", brand: "zott" }),
  label("organic-crave-chips", "organic crave protein chips", { name: "chips", brand: "crave" }),
  label("danone-skyr-nature", "skyr nature danone", { name: "skyr", brand: "danone" }),
  label("florette-jeunes-pousses", "florette jeunes pousses 80g", {
    name: "jeunes pousses",
    brand: "florette",
  }),
  label("kefirade-citron", "kéfirade citron", { name: "citron", brand: "kefirade" }),
  label("zanetti-ricotta", "ricotta zanetti", { name: "ricotta", brand: "zanetti" }),
  label("u-hache-5", "U viande hachée 5%", { name: "hachee 5", brand: "u" }, "one-letter brand in the query"),
  label(
    "primeal-macaroni",
    { product: "macaroni", brand: "Priméal" },
    { name: "macaroni", brand: "primeal" },
  ),
  label(
    "primeal-petales-paprika",
    { product: "pétales paprika fumé", brand: "Priméal" },
    { name: "paprika", brand: "primeal" },
  ),
  label("montignac-pain", "pain intégral montignac", { name: "pain integral", brand: "montignac" }),
  label("supernature-muesli", "muesli sportif supernature", { name: "muesli sportif", brand: "supernature" }),
  label(
    "haagen-sorbet-citron",
    "sorbet citron häagen-dazs",
    { ean: "3415587116117" },
    "French name field is English",
  ),
  label("leffe-ruby-00", "leffe ruby 0.0", { name: "ruby 0", brand: "leffe" }, "numbers carry no weight"),
  // generic foods (Ciqual)
  generic("generic-banane", "banane", "banane crue"),
  generic("generic-banana-en", "banana", "banane crue"),
  generic("generic-riz-basmati-cuit", "riz basmati cuit", "riz basmati cuit"),
  generic("generic-poulet", "blanc de poulet", "poulet filet"),
  generic("generic-pomme", "pomme", "pomme crue"),
  generic("generic-huile-olive", "huile d'olive", "huile olive"),
  generic("generic-oeuf", "oeuf dur", "oeuf dur"),
  generic("generic-lait-demi", "lait demi-écrémé", "lait demi ecreme"),
];
