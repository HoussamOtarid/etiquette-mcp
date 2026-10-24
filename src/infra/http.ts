import type { Logger } from "./logger.ts";
import { HostLimiter, type RateLimit } from "./rateLimiter.ts";

export class HttpError extends Error {
  readonly status: number;
  readonly host: string;

  constructor(status: number, host: string) {
    super(`HTTP ${status} from ${host}`);
    this.status = status;
    this.host = host;
    this.name = "HttpError";
  }
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
  /** Per-host limits; keys are exact hosts or "*.domain" patterns. */
  limits?: Record<string, RateLimit>;
  /** Refuse to queue a request that would wait longer than this (the caller would have given up anyway). */
  maxQueueWaitMs?: number;
  logger: Logger;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  /** Accept these statuses without throwing (e.g. 404 handled by the caller). */
  allowStatus?: number[];
}

export interface HttpResponse<T> {
  status: number;
  url: string;
  body: T;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 5000;

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
   * One limiter per configured key: an exact host, or a "*.domain" pattern shared by all its subdomains.
   */
  private limiterFor(host: string): HostLimiter {
    const limits = this.options.limits ?? {};
    const key =
      host in limits
        ? host
        : (Object.keys(limits).find((k) => k.startsWith("*.") && host.endsWith(k.slice(1))) ?? host);
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
    const host = new URL(url).host;
    const limiter = this.limiterFor(host);
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
      if (attempt === 0 && RETRYABLE.has(response.status)) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Math.min(
          MAX_RETRY_DELAY_MS,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500,
        );
        this.options.logger.info("http retry", { host, status: response.status, delay });
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      this.options.logger.warn("http error", { host, status: response.status, ms });
      throw new HttpError(response.status, host);
    }
  }
}
