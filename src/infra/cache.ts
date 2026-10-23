import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Marker stored for "looked up, nothing there", so misses are cached too (with a shorter TTL). */
const MISS = { __miss: true } as const;

/**
 * Small persistent key-value cache with per-entry TTL, backed by SQLite (node:sqlite, no native dependency).
 * Concurrent lookups of the same key share one in-flight promise.
 */
export class Cache {
  private readonly db: DatabaseSync;
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS cache (
        ns TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (ns, key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS cache_expiry ON cache (expires_at);
    `);
  }

  get database(): DatabaseSync {
    return this.db;
  }

  /** Returns the cached value, `null` for a cached miss, or `undefined` when absent or expired. */
  get<T>(ns: string, key: string): T | null | undefined {
    const row = this.db
      .prepare("SELECT value, expires_at FROM cache WHERE ns = ? AND key = ?")
      .get(ns, key) as { value: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= Date.now()) return undefined;
    const value = JSON.parse(row.value) as T | typeof MISS;
    return typeof value === "object" && value !== null && "__miss" in value ? null : (value as T);
  }

  set(ns: string, key: string, value: unknown, ttlMs: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO cache (ns, key, value, expires_at) VALUES (?, ?, ?, ?)")
      .run(ns, key, JSON.stringify(value ?? MISS), Date.now() + ttlMs);
  }

  /**
   * Read-through helper. `fn` returning null is cached as a miss for `missTtlMs`; thrown errors are not cached.
   */
  async wrap<T>(
    ns: string,
    key: string,
    ttl: { hitMs: number; missMs: number },
    fn: () => Promise<T | null>,
  ): Promise<{ value: T | null; cached: boolean }> {
    const hit = this.get<T>(ns, key);
    if (hit !== undefined) return { value: hit, cached: true };
    const id = `${ns}\u0000${key}`;
    let pending = this.inflight.get(id) as Promise<T | null> | undefined;
    if (!pending) {
      pending = fn()
        .then((value) => {
          this.set(ns, key, value, value === null ? ttl.missMs : ttl.hitMs);
          return value;
        })
        .finally(() => this.inflight.delete(id));
      this.inflight.set(id, pending);
    }
    return { value: await pending, cached: false };
  }

  purgeExpired(): number {
    const result = this.db.prepare("DELETE FROM cache WHERE expires_at <= ?").run(Date.now());
    return Number(result.changes);
  }

  stats(): { entries: number } {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM cache").get() as { n: number };
    return { entries: row.n };
  }

  close(): void {
    this.db.close();
  }
}

export const TTL = {
  search: { hitMs: 6 * 3600_000, missMs: 3600_000 },
  label: { hitMs: 7 * 24 * 3600_000, missMs: 24 * 3600_000 },
  token: { hitMs: 24 * 3600_000, missMs: 600_000 },
} as const;
