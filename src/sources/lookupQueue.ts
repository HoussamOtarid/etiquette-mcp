import { HttpError } from "../infra/http.ts";

export interface LookupQueueOptions {
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = new Set([429, 503]);

function isThrottled(error: unknown): error is HttpError {
  return error instanceof HttpError && RETRYABLE.has(error.status);
}

/**
 * Serialises lookups to a rate-limited API: one request at a time, concurrent lookups of the same key share one
 * request, and a rate-limit answer (429/503) pauses the queue (Retry-After, else exponential backoff), which also holds
 * back every lookup waiting behind it.
 */
export class LookupQueue<T> {
  private readonly pending = new Map<string, Promise<T | null>>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly fetch: (key: string) => Promise<T | null>;
  private readonly options: LookupQueueOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(fetch: (key: string) => Promise<T | null>, options: LookupQueueOptions) {
    this.fetch = fetch;
    this.options = options;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  lookup(key: string): Promise<T | null> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const run = this.tail.then(() => this.fetchWithBackoff(key));
    this.tail = run.catch(() => undefined);
    const result = run.finally(() => this.pending.delete(key));
    this.pending.set(key, result);
    return result;
  }

  private async fetchWithBackoff(key: string): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.fetch(key);
      } catch (error) {
        if (!isThrottled(error) || attempt >= this.options.maxRetries) throw error;
        const backoff = this.options.baseBackoffMs * 2 ** attempt;
        await this.sleep(Math.min(this.options.maxBackoffMs, error.retryAfterMs ?? backoff));
      }
    }
  }
}
