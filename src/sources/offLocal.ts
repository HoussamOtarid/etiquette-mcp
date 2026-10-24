import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OffProduct } from "./openFoodFacts.ts";

export interface LocalCopyStatus {
  products: number;
  /** When the last full import finished (ISO). */
  full_import_at: string | null;
  /** When the copy last changed: full import or daily updates (ISO). */
  updated_at: string | null;
}

/** Read side of the local Open Food Facts copy, as used by the adapter. */
export interface OffLocalReader {
  get(code: string): OffProduct | null;
  status(): LocalCopyStatus | null;
}

export const META = {
  format: "format",
  fullImportAt: "full_import_at",
  updatedAt: "updated_at",
  products: "products",
  lastDeltaEnd: "last_delta_end",
} as const;

/**
 * Each full import writes a new `off-<time>.db`; `off.current` names the one in use and is switched atomically, so a
 * build in progress or a failed one never affects the copy being read. Daily updates change the current file in place.
 */
const POINTER = "off.current";
const COPY = /^off-\d+\.db(-wal|-shm)?$/;

export function newCopyPath(dataDir: string, now: number): string {
  return join(dataDir, `off-${now}.db`);
}

export function currentCopyPath(dataDir: string): string | null {
  const pointer = join(dataDir, POINTER);
  if (!existsSync(pointer)) return null;
  const path = join(dataDir, readFileSync(pointer, "utf8").trim());
  return existsSync(path) ? path : null;
}

export function useCopy(dataDir: string, path: string): void {
  const pointer = join(dataDir, POINTER);
  writeFileSync(`${pointer}.tmp`, basename(path));
  renameSync(`${pointer}.tmp`, pointer);
}

/** Deletes copies other than the current one (old versions, interrupted builds). Run when no import is running. */
export function removeStaleCopies(dataDir: string): string[] {
  if (!existsSync(dataDir)) return [];
  const current = currentCopyPath(dataDir);
  const keep = current ? basename(current) : null;
  const stale = readdirSync(dataDir).filter((f) => COPY.test(f) && (!keep || !f.startsWith(keep)));
  for (const f of stale) rmSync(join(dataDir, f), { force: true });
  return stale;
}

/**
 * Shape of the stored products. A copy built in another shape (older server version) is not used: the server answers
 * from the API and rebuilds it. Bump when trimOffProduct changes what it stores.
 */
export const COPY_FORMAT = 4;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS products (code TEXT PRIMARY KEY, doc TEXT NOT NULL, modified INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

/** Opens (and creates if needed) a copy for writing. */
export function openForWrite(path: string, { bulk = false } = {}): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // A bulk build goes to a temporary file that is discarded on failure, so durability is not needed there.
  db.exec(bulk ? "PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;" : "PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

/** Inserts or replaces products, keeping the stored version when it is newer than the incoming one. */
export function upsertProducts(db: DatabaseSync, products: OffProduct[]): void {
  const statement = db.prepare(
    `INSERT INTO products (code, doc, modified) VALUES (?, ?, ?)
     ON CONFLICT (code) DO UPDATE SET doc = excluded.doc, modified = excluded.modified
     WHERE excluded.modified >= products.modified`,
  );
  db.exec("BEGIN");
  try {
    for (const p of products) statement.run(p.code ?? "", JSON.stringify(p), p.last_modified_t ?? 0);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function setMeta(db: DatabaseSync, values: Record<string, string | number>): void {
  const statement = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(values)) statement.run(key, String(value));
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function countProducts(db: DatabaseSync): number {
  return (db.prepare("SELECT count(*) AS n FROM products").get() as { n: number }).n;
}

const iso = (ms: string | null) => (ms ? new Date(Number(ms)).toISOString() : null);

/** The local copy, read by the server. Missing until the first import; reopened after each rebuild. */
export class OffLocalStore implements OffLocalReader {
  private db: DatabaseSync | null = null;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.reopen();
  }

  /** Switches to the copy `off.current` names (after a rebuild). */
  reopen(): void {
    this.db?.close();
    this.db = null;
    const path = currentCopyPath(this.dataDir);
    if (!path) return;
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    if (getMeta(db, META.format) !== String(COPY_FORMAT)) {
      db.close();
      return;
    }
    this.db = db;
  }

  get(code: string): OffProduct | null {
    if (!this.db) return null;
    const row = this.db.prepare("SELECT doc FROM products WHERE code = ?").get(code) as
      | { doc: string }
      | undefined;
    return row ? (JSON.parse(row.doc) as OffProduct) : null;
  }

  status(): LocalCopyStatus | null {
    if (!this.db) return null;
    return {
      products: Number(getMeta(this.db, META.products) ?? 0),
      full_import_at: iso(getMeta(this.db, META.fullImportAt)),
      updated_at: iso(getMeta(this.db, META.updatedAt)),
    };
  }

  /** Raw timestamps (ms) for scheduling. */
  times(): { fullImportAt: number | null; updatedAt: number | null } {
    const read = (key: string) => {
      const value = this.db ? getMeta(this.db, key) : null;
      return value ? Number(value) : null;
    };
    return { fullImportAt: read(META.fullImportAt), updatedAt: read(META.updatedAt) };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
