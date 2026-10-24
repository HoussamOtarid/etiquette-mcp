import type { Logger } from "./logger.ts";
import { HostLimiter, type RateLimit } from "./rateLimiter.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly host: string;
  /** Delay requested by the server's Retry-After header, when present. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, host: string, retryAfterMs?: number) {
    super(`HTTP ${status} from ${host}`);
    this.status = status;
    this.host = host;
    this.retryAfterMs = retryAfterMs;
    this.name = "HttpError";
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export class RateLimitedError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(`Rate limit queue for ${host} is full`);
    this.host = host;
    this.name = "RateLimitedError";
  }
}

export interface HttpClientOptions {
  userAgent: string;
  timeoutMs: number;
  defaultLimit: RateLimit;
  /** Per-host limits; keys are "host/path-prefix", exact hosts or "*.domain" patterns. */
  limits?: Record<string, RateLimit>;
  /** Refuse to queue a request that would wait longer than this (the caller would have given up anyway). */
  maxQueueWaitMs?: number;
  logger: Logger;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Accept these statuses without throwing (e.g. 404 handled by the caller). */
  allowStatus?: number[];
  /** Retry once on 429/5xx (default true). Callers with their own backoff turn it off. */
  retry?: boolean;
}

export interface HttpResponse<T> {
  status: number;
  url: string;
  body: T;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 1500;

/**
 * Outbound HTTP for all sources. Requests are anonymous by construction: a fixed neutral User-Agent, no cookies
 * (Node's fetch has no cookie jar), no credentials, and per-host rate limiting.
 */
export class HttpClient {
  private readonly limiters = new Map<string, HostLimiter>();

  private readonly options: HttpClientOptions;

  constructor(options: HttpClientOptions) {
    this.options = options;
  }

  async getText(url: string, opts: RequestOptions = {}): Promise<HttpResponse<string>> {
    return this.request(url, { method: "GET" }, opts, (r) => r.text());
  }

  async getJson<T>(url: string, opts: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request(
      url,
      { method: "GET" },
      { ...opts, headers: { accept: "application/json", ...opts.headers } },
      (r) => r.json() as Promise<T>,
    );
  }

  async postJson<T>(url: string, body: unknown, opts: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request(
      url,
      { method: "POST", body: JSON.stringify(body) },
      {
        ...opts,
        headers: { "content-type": "application/json", accept: "application/json", ...opts.headers },
      },
      (r) => r.json() as Promise<T>,
    );
  }

  /**
   * One limiter per configured key, most specific first: "host/path-prefix" (endpoints with their own quota), an exact
   * host, or a "*.domain" pattern shared by all its subdomains.
   */
  private limiterFor(url: URL): HostLimiter {
    const limits = this.options.limits ?? {};
    const keys = Object.keys(limits);
    const target = `${url.host}${url.pathname}`;
    const key =
      keys.filter((k) => k.includes("/") && target.startsWith(k)).sort((a, b) => b.length - a.length)[0] ??
      (url.host in limits ? url.host : undefined) ??
      keys.find((k) => k.startsWith("*.") && url.host.endsWith(k.slice(1))) ??
      url.host;
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = new HostLimiter(limits[key] ?? this.options.defaultLimit);
      this.limiters.set(key, limiter);
    }
    return limiter;
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    opts: RequestOptions,
    read: (r: Response) => Promise<T>,
  ): Promise<HttpResponse<T>> {
    const parsed = new URL(url);
    const host = parsed.host;
    const limiter = this.limiterFor(parsed);
    const maxWait = this.options.maxQueueWaitMs;
    if (maxWait !== undefined && limiter.estimatedWaitMs() > maxWait) throw new RateLimitedError(host);

    const headers = {
      "user-agent": this.options.userAgent,
      "accept-language": "fr-FR,fr;q=0.9",
      ...opts.headers,
    };

    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const response = await limiter.schedule(() =>
        fetch(url, {
          ...init,
          headers,
          redirect: "follow",
          credentials: "omit",
          signal: AbortSignal.timeout(this.options.timeoutMs),
        }),
      );
      const ms = Date.now() - started;
      if (response.ok || opts.allowStatus?.includes(response.status)) {
        this.options.logger.debug("http", { host, status: response.status, ms });
        return { status: response.status, url: response.url, body: await read(response) };
      }
      await response.body?.cancel();
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      if (attempt === 0 && opts.retry !== false && RETRYABLE.has(response.status)) {
        const delay = Math.min(MAX_RETRY_DELAY_MS, retryAfterMs ?? DEFAULT_RETRY_DELAY_MS);
        this.options.logger.info("http retry", { host, status: response.status, delay });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      this.options.logger.warn("http error", { host, status: response.status, ms });
      throw new HttpError(response.status, host, retryAfterMs);
    }
  }
}
