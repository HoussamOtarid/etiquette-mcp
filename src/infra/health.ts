import type { SourceId } from "../domain/types.ts";

export type OutcomeKind =
  | "ok"
  | "not_found"
  | "timeout"
  | "rate_limited"
  | "http_error"
  | "parse_error"
  | "error";

interface SourceStats {
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: OutcomeKind | null;
  recent: Array<{ at: number; kind: OutcomeKind; ms: number }>;
}

export interface SourceHealthSnapshot {
  source: SourceId;
  status: "ok" | "degraded" | "unknown";
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: OutcomeKind | null;
  calls24h: number;
  failures24h: number;
  p50Ms: number | null;
}

const WINDOW_MS = 24 * 3600_000;
const MAX_RECENT = 500;
const FAILURES: OutcomeKind[] = ["timeout", "http_error", "parse_error", "error"];

/** In-memory per-source outcome tracking, exposed through the `list_sources` tool. */
export class HealthTracker {
  private readonly stats = new Map<SourceId, SourceStats>();

  record(source: SourceId, kind: OutcomeKind, ms: number): void {
    const s = this.stats.get(source) ?? {
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailure: null,
      recent: [],
    };
    const now = new Date();
    if (kind === "ok" || kind === "not_found") s.lastSuccessAt = now.toISOString();
    else {
      s.lastFailureAt = now.toISOString();
      s.lastFailure = kind;
    }
    s.recent.push({ at: now.getTime(), kind, ms });
    if (s.recent.length > MAX_RECENT) s.recent.splice(0, s.recent.length - MAX_RECENT);
    this.stats.set(source, s);
  }

  snapshot(sources: readonly SourceId[]): SourceHealthSnapshot[] {
    const since = Date.now() - WINDOW_MS;
    return sources.map((source) => {
      const s = this.stats.get(source);
      const recent = s?.recent.filter((r) => r.at >= since) ?? [];
      const failures = recent.filter((r) => FAILURES.includes(r.kind)).length;
      const durations = recent.map((r) => r.ms).sort((a, b) => a - b);
      const lastTen = recent.slice(-10);
      const degraded =
        lastTen.length >= 3 &&
        lastTen.filter((r) => FAILURES.includes(r.kind)).length / lastTen.length >= 0.5;
      return {
        source,
        status: recent.length === 0 ? "unknown" : degraded ? "degraded" : "ok",
        lastSuccessAt: s?.lastSuccessAt ?? null,
        lastFailureAt: s?.lastFailureAt ?? null,
        lastFailure: s?.lastFailure ?? null,
        calls24h: recent.length,
        failures24h: failures,
        p50Ms: durations.length ? (durations[Math.floor(durations.length / 2)] ?? null) : null,
      };
    });
  }
}
