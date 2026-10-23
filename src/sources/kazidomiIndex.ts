import type { DatabaseSync } from "node:sqlite";
import { nameTokens, normalizeText } from "../domain/text.ts";

export interface IndexedProduct {
  id: number;
  slug: string;
  brand: string;
  name: string;
}

const REFRESH_MS = 24 * 3600_000;

/** Product slugs look like "<brand>-<id>-<name>", e.g. "lima-367-boisson-d-avoine-sans-gluten-bio-1l". */
export function parseSitemap(xml: string): IndexedProduct[] {
  const out: IndexedProduct[] = [];
  for (const m of xml.matchAll(
    /<loc>https:\/\/www\.kazidomi\.com\/fr\/catalogue\/produits\/([a-z0-9-]+)<\/loc>/g,
  )) {
    const slug = m[1];
    const parts = slug ? /^([a-z0-9]+(?:-[a-z0-9]+)*?)-(\d+)-([a-z0-9-]+)$/.exec(slug) : null;
    if (!slug || !parts?.[1] || !parts[2] || !parts[3]) continue;
    out.push({
      id: Number(parts[2]),
      slug,
      brand: parts[1].replace(/-/g, " "),
      name: parts[3].replace(/-/g, " "),
    });
  }
  return out;
}

/** Local full-text index of the Kazidomi catalogue (the shop has no public search endpoint). */
export class KazidomiIndex {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS kazidomi_fts USING fts5(
        id UNINDEXED, slug UNINDEXED, brand, name, tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS kazidomi_ean (ean TEXT PRIMARY KEY, id INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS kazidomi_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
  }

  isStale(now = Date.now()): boolean {
    const row = this.db.prepare("SELECT value FROM kazidomi_meta WHERE key = 'refreshed_at'").get() as
      | { value: string }
      | undefined;
    return !row || now - Number(row.value) > REFRESH_MS;
  }

  size(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM kazidomi_fts").get() as { n: number }).n;
  }

  replaceAll(products: IndexedProduct[]): void {
    if (products.length === 0) return;
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM kazidomi_fts");
      const insert = this.db.prepare("INSERT INTO kazidomi_fts (id, slug, brand, name) VALUES (?, ?, ?, ?)");
      for (const p of products) insert.run(p.id, p.slug, p.brand, p.name);
      this.db
        .prepare("INSERT OR REPLACE INTO kazidomi_meta (key, value) VALUES ('refreshed_at', ?)")
        .run(String(Date.now()));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Best matches for a name/keyword query; all words must match (prefix match), ranked by BM25. */
  search(text: string, brand: string | undefined, limit: number): IndexedProduct[] {
    const words = [...nameTokens(text), ...(brand ? normalizeText(brand).split(" ") : [])].filter(
      (w) => w.length >= 2,
    );
    if (words.length === 0) return [];
    const match = words.map((w) => `"${w.replace(/"/g, "")}"*`).join(" ");
    return this.db
      .prepare(
        "SELECT id, slug, brand, name FROM kazidomi_fts WHERE kazidomi_fts MATCH ? ORDER BY bm25(kazidomi_fts, 0, 0, 2, 1) LIMIT ?",
      )
      .all(match, limit) as unknown as IndexedProduct[];
  }

  rememberEan(ean: string, id: number): void {
    this.db.prepare("INSERT OR REPLACE INTO kazidomi_ean (ean, id) VALUES (?, ?)").run(ean, id);
  }

  idForEan(ean: string): number | null {
    const row = this.db.prepare("SELECT id FROM kazidomi_ean WHERE ean = ?").get(ean) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }
}
