import { HttpError } from "../infra/http.ts";

export interface BatcherOptions {
  maxBatch: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Waiter<T> {
  resolve: (value: T | null) => void;
  reject: (reason: unknown) => void;
}

const RETRYABLE = new Set([429, 503]);

/**
 * Coalesces barcode lookups: a single worker sends one request at a time, and every barcode requested while a request
 * is in flight joins the next one. One pending barcode uses `fetchOne`, several use `fetchMany`.
 * Rate-limit answers (429/503) pause the worker, which also holds back every queued lookup.
 */
export class BarcodeBatcher<T> {
  private readonly pending = new Map<string, Array<Waiter<T>>>();
  private running = false;
  private readonly fetchOne: (code: string) => Promise<T | null>;
  private readonly fetchMany: (codes: string[]) => Promise<Map<string, T>>;
  private readonly options: BatcherOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    fetchOne: (code: string) => Promise<T | null>,
    fetchMany: (codes: string[]) => Promise<Map<string, T>>,
    options: BatcherOptions,
  ) {
    this.fetchOne = fetchOne;
    this.fetchMany = fetchMany;
    this.options = options;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get queued(): number {
    return this.pending.size;
  }

  lookup(code: string): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const waiters = this.pending.get(code) ?? [];
      waiters.push({ resolve, reject });
      this.pending.set(code, waiters);
      if (!this.running) void this.run();
    });
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (this.pending.size > 0) {
        const batch = [...this.pending.keys()].slice(0, this.options.maxBatch);
        const waiters = batch.map((code) => [code, this.pending.get(code) ?? []] as const);
        for (const code of batch) this.pending.delete(code);
        try {
          const results = await this.fetchWithBackoff(batch);
          for (const [code, list] of waiters) for (const w of list) w.resolve(results.get(code) ?? null);
        } catch (error) {
          for (const [, list] of waiters) for (const w of list) w.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async fetchWithBackoff(batch: string[]): Promise<Map<string, T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (batch.length === 1 && batch[0]) {
          const value = await this.fetchOne(batch[0]);
          return value === null ? new Map() : new Map([[batch[0], value]]);
        }
        return await this.fetchMany(batch);
      } catch (error) {
        const retryable = error instanceof HttpError && RETRYABLE.has(error.status);
        if (!retryable || attempt >= this.options.maxRetries) throw error;
        const backoff = this.options.baseBackoffMs * 2 ** attempt;
        await this.sleep(Math.min(this.options.maxBackoffMs, error.retryAfterMs ?? backoff));
      }
    }
  }
}
