import { HttpError } from "../infra/http.ts";

export interface BatcherOptions {
  maxBatch: number;
  maxRetries: number;
  /** How long to stop using `fetchMany` after it was throttled, when the server gives no Retry-After. */
  manyCooldownMs?: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Waiter<T> {
  resolve: (value: T | null) => void;
  reject: (reason: unknown) => void;
}

const RETRYABLE = new Set([429, 503]);

function isThrottled(error: unknown): error is HttpError {
  return error instanceof HttpError && RETRYABLE.has(error.status);
}

/**
 * Coalesces barcode lookups: a single worker sends one request at a time, and every barcode requested while a request
 * is in flight joins the next one. One pending barcode uses `fetchOne`, several use `fetchMany` when the source has a
 * multi-barcode lookup (otherwise they are fetched one by one).
 * If `fetchMany` is throttled, it cools down and barcodes are fetched one by one with `fetchOne` meanwhile.
 * Rate-limit answers to `fetchOne` (429/503) pause the worker, which also holds back every queued lookup.
 */
export class BarcodeBatcher<T> {
  private readonly pending = new Map<string, Array<Waiter<T>>>();
  private running = false;
  private manyAvailableAt = 0;
  private readonly fetchOne: (code: string) => Promise<T | null>;
  private readonly fetchMany: ((codes: string[]) => Promise<Map<string, T>>) | undefined;
  private readonly options: BatcherOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    fetchOne: (code: string) => Promise<T | null>,
    fetchMany: ((codes: string[]) => Promise<Map<string, T>>) | undefined,
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
          const { values, errors } = await this.fetchWithBackoff(batch);
          for (const [code, list] of waiters) {
            const error = errors.get(code);
            for (const w of list) {
              if (error === undefined) w.resolve(values.get(code) ?? null);
              else w.reject(error);
            }
          }
        } catch (error) {
          for (const [, list] of waiters) for (const w of list) w.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async fetchWithBackoff(
    batch: string[],
  ): Promise<{ values: Map<string, T>; errors: Map<string, unknown> }> {
    const errors = new Map<string, unknown>();
    if (this.fetchMany && batch.length > 1 && Date.now() >= this.manyAvailableAt) {
      try {
        return { values: await this.fetchMany(batch), errors };
      } catch (error) {
        if (!isThrottled(error)) throw error;
        this.manyAvailableAt = Date.now() + (error.retryAfterMs ?? this.options.manyCooldownMs ?? 0);
      }
    }
    const values = new Map<string, T>();
    for (const code of batch) {
      try {
        const value = await this.fetchOneWithBackoff(code);
        if (value !== null) values.set(code, value);
      } catch (error) {
        errors.set(code, error);
      }
    }
    return { values, errors };
  }

  private async fetchOneWithBackoff(code: string): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.fetchOne(code);
      } catch (error) {
        if (!isThrottled(error) || attempt >= this.options.maxRetries) throw error;
        const backoff = this.options.baseBackoffMs * 2 ** attempt;
        await this.sleep(Math.min(this.options.maxBackoffMs, error.retryAfterMs ?? backoff));
      }
    }
  }
}
