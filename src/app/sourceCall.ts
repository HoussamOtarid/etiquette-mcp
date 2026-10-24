import type { SourceId } from "../domain/types.ts";
import type { HealthTracker, OutcomeKind } from "../infra/health.ts";
import { HttpError, RateLimitedError } from "../infra/http.ts";
import type { SourceStatus } from "./types.ts";

export type Outcome<T> =
  | { status: "ok"; value: T; ms: number }
  | { status: Exclude<SourceStatus, "ok">; ms: number };

function classify(error: unknown): OutcomeKind {
  if (error instanceof RateLimitedError) return "rate_limited";
  if (error instanceof HttpError) {
    if (error.status === 404) return "not_found";
    return error.status === 429 || error.status === 503 ? "rate_limited" : "http_error";
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return "timeout";
  if (error instanceof SyntaxError) return "parse_error";
  return "error";
}

function toStatus(kind: OutcomeKind): Exclude<SourceStatus, "ok"> {
  if (kind === "http_error" || kind === "parse_error") return "error";
  return kind === "ok" ? "error" : kind;
}

/**
 * Runs one source call with a time limit. The call is not cancelled when the limit is reached: it keeps running
 * in the background so its result still lands in the cache for the next request.
 */
export async function callSource<T>(
  source: SourceId,
  run: () => Promise<T>,
  limitMs: number,
  health: HealthTracker,
): Promise<Outcome<T>> {
  const started = Date.now();
  if (limitMs <= 0) return { status: "timeout", ms: 0 };
  const task = run().then(
    (value) => {
      health.record(source, "ok", Date.now() - started);
      return { status: "ok" as const, value, ms: Date.now() - started };
    },
    (error: unknown) => {
      const kind = classify(error);
      health.record(source, kind, Date.now() - started);
      return { status: toStatus(kind), ms: Date.now() - started };
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Outcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout", ms: Date.now() - started }), limitMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps the most informative status when a source is called several times in one request. */
export function mergeStatus(a: SourceStatus | undefined, b: SourceStatus): SourceStatus {
  const order: SourceStatus[] = ["ok", "not_found", "rate_limited", "timeout", "error", "not_supported"];
  if (!a) return b;
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}
