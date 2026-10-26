import * as cheerio from "cheerio";
import { parseQuantity } from "../domain/quantity.ts";
import type { Offer } from "../domain/types.ts";
import { TTL } from "../infra/cache.ts";
import {
  type AdapterDeps,
  cleanText,
  emptyLabel,
  finalizeLabel,
  type LabelResult,
  type SearchQuery,
  type SourceAdapter,
} from "./adapter.ts";
import { cachedSearch, eanOf, matchingEan, priceOf } from "./shared.ts";
import { parseTextLabel } from "./textLabel.ts";

const SITE = "https://www.picard.fr";
const SEARCH = `${SITE}/on/demandware.store/Sites-picard-Site/fr_FR/Search-UpdateGrid`;
const PRODUCT = `${SITE}/on/demandware.store/Sites-picard-Site/fr_FR/Product-Show`;
const PRODUCT_PATH = /^\/produits\/[a-z0-9-]+-(\d{18})\.html$/;
/**
 * Picard's GS1 company prefix: barcodes of the products Picard makes are this prefix, the 5-digit product id and a
 * check digit (3270160 10135 1 ↔ product 10135). Other brands sold at Picard have their own barcodes.
 */
const PICARD_PREFIX = "3270160";

interface Gtm {
  item_id?: string;
  item_name?: string;
  item_brand?: string;
  item_format?: string;
  price?: number;
}

const readGtm = (raw: string | undefined): Gtm => {
  try {
    return JSON.parse(raw ?? "") as Gtm;
  } catch {
    return {};
  }
};

/** Tiles name Picard's own products "PICARD" (or one of its ranges) and the others by their brand. */
function brandOf(gtm: Gtm): string | null {
  const brand = cleanText(gtm.item_brand);
  if (!brand || /^without brand$/i.test(brand)) return null;
  return /^picard$/i.test(brand) ? "Picard" : brand;
}

export function parsePicardSearch(html: string): Offer[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  return $("[data-pid][data-gtm]")
    .toArray()
    .flatMap((el) => {
      const $el = $(el);
      const pid = $el.attr("data-pid") ?? "";
      const href =
        $el.find("a.product-main-link").attr("href") ?? $el.find("a[href*='/produits/']").attr("href");
      if (!/^\d{18}$/.test(pid) || seen.has(pid) || !href) return [];
      seen.add(pid);
      const gtm = readGtm($el.attr("data-gtm"));
      const name =
        cleanText(
          $el
            .find("a.product-main-link")
            .attr("aria-label")
            ?.replace(/^d[ée]couvrir\s+/i, ""),
        ) ?? cleanText(gtm.item_name);
      if (!name) return [];
      const url = new URL(href, SITE).toString();
      return [
        {
          source: "picard" as const,
          sourceProductId: url,
          url,
          name,
          brand: brandOf(gtm),
          ean: null,
          sizeText: cleanText(gtm.item_format),
          priceEur: priceOf(gtm.price),
          inStock: null,
        },
      ];
    });
}

/** The table lists per 100 g, then per portion; compound rows read "Matières grasses : 3,7 g dont … : 0,4 g". */
function tableText($: cheerio.CheerioAPI, column: number): { header: string | null; text: string | null } {
  const rows = $("table.pi-ProductTabsNutrition-table tr")
    .toArray()
    .map((tr) =>
      $(tr)
        .find("th,td")
        .toArray()
        .map((c) => cleanText($(c).text()) ?? ""),
    );
  const header = cleanText(rows[0]?.[column === 1 ? 1 : 2]);
  const lines = rows.slice(2).flatMap((cells) => {
    const name = cells[0];
    const value = cells[column];
    if (!name || !value) return [];
    return [value.includes(":") ? value : `${name} : ${value}`];
  });
  return { header, text: lines.length > 0 ? `${header ?? ""} : ${lines.join(", ")}` : null };
}

function tabBlocks($: cheerio.CheerioAPI, title: RegExp): Array<{ title: string | null; text: string }> {
  const target = $("button.pi-ProductTabs-navBtn")
    .filter((_, b) => title.test($(b).text()))
    .first()
    .attr("data-target");
  if (!target) return [];
  return $(`#${target} .pi-ProductTabsCms-block`)
    .toArray()
    .map((b) => ({
      title: cleanText($(b).find(".pi-ProductTabsCms-title").text()),
      text: cleanText($(b).find(".pi-ProductTabsCms-text").text()) ?? "",
    }));
}

export interface PicardPage extends LabelResult {
  name: string | null;
  sizeText: string | null;
  priceEur: number | null;
}

/** A product page; null when the address leads elsewhere (product no longer sold). */
export function parsePicardProduct(html: string, url: string): PicardPage | null {
  const pid = PRODUCT_PATH.exec(new URL(url).pathname)?.[1];
  if (!pid) return null;
  const $ = cheerio.load(html);
  const label = emptyLabel("picard", url);
  const per100 = tableText($, 1);
  if (per100.text) {
    const parsed = parseTextLabel(per100.text);
    const portion = tableText($, 3);
    label.basis = parsed.basis;
    label.values = parsed.values;
    if (parsed.sodiumG !== undefined) label.sodiumG = parsed.sodiumG;
    label.extra = parsed.extra;
    label.raw = [per100.text, portion.text].filter(Boolean).join(" | ");
    const description = cleanText(portion.header?.replace(/^pour\s+/i, ""));
    if (portion.text && description) {
      const size = parseQuantity(description);
      label.portion = {
        description,
        amount: size?.amount ?? null,
        unit: size?.unit ?? null,
        values: parseTextLabel(portion.text).values,
      };
    }
  }
  const ingredients = tabBlocks($, /ingr[ée]dients/i);
  const list = ingredients.find((b) => b.title && /liste des ingr/i.test(b.title))?.text ?? null;
  label.ingredients = list;
  // Allergens are written in capitals in the ingredient list (EU labelling rule).
  const allergens = [...new Set(list?.match(/\b[A-ZÀ-ÖØ-ÝŒ]{3,}(?:\s+[A-ZÀ-ÖØ-ÝŒ]{3,})*\b/g) ?? [])];
  label.allergens = allergens.length > 0 ? allergens.map((a) => a.toLowerCase()).join(", ") : null;
  label.traces = cleanText(
    ingredients.map((b) => /peut contenir[^:]*:\s*(.+)$/i.exec(b.text)?.[1]).find(Boolean) ?? null,
  );
  label.nutriscore =
    /nutri-score du produit\s*:\s*([A-E])\b/i.exec(
      $(".pi-ProductTabsNutrition-nutriscoreTitle").text(),
    )?.[1] ?? null;
  label.dataOrigin = "store";
  const gtm = readGtm($(`[data-gtm*='"item_id":"${pid}"']`).first().attr("data-gtm"));
  return {
    label: finalizeLabel(label),
    // Some pages list several barcodes ("3270160833900 8000881003673"): the first one is the product's.
    ean: ($('meta[itemprop="gtin13"]').attr("content") ?? "").split(/\s+/).map(eanOf).find(Boolean) ?? null,
    name: cleanText($("h1").first().text()) ?? cleanText(gtm.item_name),
    sizeText: cleanText(gtm.item_format),
    priceEur: priceOf(gtm.price),
  };
}

/** The product page of a barcode Picard made, or null for other barcodes. */
export function picardProductUrl(ean: string): string | null {
  if (!ean.startsWith(PICARD_PREFIX) || ean.length !== 13) return null;
  return `${PRODUCT}?pid=${ean.slice(PICARD_PREFIX.length, 12).padStart(18, "0")}`;
}

/** Picard: frozen food chain, mostly its own products. Text search, and its own barcodes; labels on product pages. */
export class PicardAdapter implements SourceAdapter {
  readonly id = "picard" as const;
  readonly tier = "B" as const;
  readonly displayName = "Picard";
  readonly capabilities = { text: true, ean: true };

  private readonly deps: AdapterDeps;

  constructor(deps: AdapterDeps) {
    this.deps = deps;
  }

  ownsProduct(offer: Offer): boolean {
    return offer.ean?.startsWith(PICARD_PREFIX) === true;
  }

  async search(query: SearchQuery): Promise<Offer[]> {
    if (query.ean) return this.byEan(query.ean);
    if (!query.text) return [];
    const text = query.text;
    return cachedSearch(this.deps, this.id, query, async () => {
      const params = new URLSearchParams({ q: text, start: "0", sz: String(query.limit) });
      const res = await this.deps.http.getText(`${SEARCH}?${params}`);
      return parsePicardSearch(res.body).slice(0, query.limit);
    });
  }

  /** From the (cached) page, which also gives the barcode that search tiles lack. */
  async getLabel(offer: Offer): Promise<LabelResult> {
    return (offer.url ? await this.page(offer.url) : null) ?? { label: null };
  }

  /** Picard's search doesn't know barcodes, but its own barcodes give the product page directly. */
  private async byEan(ean: string): Promise<Offer[]> {
    const url = picardProductUrl(ean);
    const page = url ? await this.page(url) : null;
    if (!page?.label?.url) return [];
    const offer: Offer = {
      source: "picard",
      sourceProductId: page.label.url,
      url: page.label.url,
      name: page.name ?? ean,
      brand: "Picard",
      ean: page.ean ?? ean,
      sizeText: page.sizeText,
      priceEur: page.priceEur,
      inStock: null,
      label: page.label,
    };
    return matchingEan([offer], ean);
  }

  private async page(url: string): Promise<PicardPage | null> {
    const { value } = await this.deps.cache.wrap<PicardPage>("label:picard", url, TTL.label, async () => {
      const res = await this.deps.http.getText(url, { allowStatus: [404] });
      return res.status === 404 ? null : parsePicardProduct(res.body, res.url);
    });
    return value;
  }
}
