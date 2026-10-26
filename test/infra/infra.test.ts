import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.ts";
import { Cache } from "../../src/infra/cache.ts";
import { HealthTracker } from "../../src/infra/health.ts";
import { HttpClient, HttpError, RateLimitedError } from "../../src/infra/http.ts";
import { silentLogger } from "../../src/infra/logger.ts";
import { HostLimiter } from "../../src/infra/rateLimiter.ts";

const TOKEN = "x".repeat(32);

describe("config", () => {
  it("applies defaults", () => {
    const c = loadConfig({ MCP_AUTH_TOKEN: TOKEN });
    expect(c).toMatchObject({
      port: 3000,
      requestBudgetMs: 20000,
      disabledSources: [],
    });
  });

  it("rejects short tokens and unknown sources", () => {
    expect(() => loadConfig({ MCP_AUTH_TOKEN: "short" })).toThrow(/MCP_AUTH_TOKEN/);
    expect(() => loadConfig({ MCP_AUTH_TOKEN: TOKEN, DISABLED_SOURCES: "carrefour" })).toThrow(/carrefour/);
  });
});

describe("cache", () => {
  it("stores hits and misses and expires them", async () => {
    const cache = new Cache(":memory:");
    const fn = vi.fn().mockResolvedValueOnce({ a: 1 }).mockResolvedValueOnce(null);
    expect(await cache.wrap("ns", "k1", { hitMs: 1000, missMs: 1000 }, fn)).toEqual({
      value: { a: 1 },
      cached: false,
    });
    expect(await cache.wrap("ns", "k1", { hitMs: 1000, missMs: 1000 }, fn)).toEqual({
      value: { a: 1 },
      cached: true,
    });
    expect(await cache.wrap("ns", "k2", { hitMs: 1000, missMs: 1000 }, fn)).toEqual({
      value: null,
      cached: false,
    });
    expect(cache.get("ns", "k2")).toBeNull();
    cache.set("ns", "old", 1, -1);
    expect(cache.get("ns", "old")).toBeUndefined();
    expect(cache.purgeExpired()).toBe(1);
  });

  it("shares in-flight lookups", async () => {
    const cache = new Cache(":memory:");
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });
    const ttl = { hitMs: 1000, missMs: 1000 };
    const [a, b] = await Promise.all([cache.wrap("n", "k", ttl, fn), cache.wrap("n", "k", ttl, fn)]);
    expect(a.value).toBe(42);
    expect(b.value).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("rate limiter", () => {
  it("spaces request starts", async () => {
    const limiter = new HostLimiter({ intervalMs: 30, concurrency: 1 });
    const starts: number[] = [];
    await Promise.all([1, 2, 3].map(() => limiter.schedule(async () => starts.push(Date.now()))));
    expect((starts[2] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(55);
  });
});

describe("http client", () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () =>
    new HttpClient({
      userAgent: "test-agent",
      timeoutMs: 1000,
      defaultLimit: { intervalMs: 0, concurrency: 4 },
      logger: silentLogger,
    });

  it("sends the neutral user agent and never credentials", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await client().getJson<{ ok: boolean }>("https://example.org/x");
    expect(res.body.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(init.headers["user-agent"]).toBe("test-agent");
    expect(init.credentials).toBe("omit");
  });

  it("throws HttpError, unless the status is allowed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    await expect(client().getText("https://example.org/missing")).rejects.toBeInstanceOf(HttpError);
    const res = await client().getText("https://example.org/missing", { allowStatus: [404] });
    expect(res.status).toBe(404);
  });

  it("applies wildcard host limits to subdomains", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const limited = new HttpClient({
      userAgent: "t",
      timeoutMs: 1000,
      defaultLimit: { intervalMs: 0, concurrency: 4 },
      limits: { "*.search.example": { intervalMs: 10_000, concurrency: 1 } },
      maxQueueWaitMs: 100,
      logger: silentLogger,
    });
    await limited.getText("https://a1-dsn.search.example/q");
    await expect(limited.getText("https://b2-dsn.search.example/q")).rejects.toBeInstanceOf(RateLimitedError);
    await expect(limited.getText("https://other.example/q")).resolves.toMatchObject({ status: 200 });
  });

  it("applies path-specific limits before host limits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const limited = new HttpClient({
      userAgent: "t",
      timeoutMs: 1000,
      defaultLimit: { intervalMs: 0, concurrency: 4 },
      limits: {
        "api.example/search": { intervalMs: 10_000, concurrency: 1 },
        "api.example": { intervalMs: 0, concurrency: 4 },
      },
      maxQueueWaitMs: 100,
      logger: silentLogger,
    });
    await limited.getText("https://api.example/search?q=1");
    await expect(limited.getText("https://api.example/search?q=2")).rejects.toBeInstanceOf(RateLimitedError);
    await expect(limited.getText("https://api.example/product/1")).resolves.toMatchObject({ status: 200 });
  });

  it("refuses to queue beyond the allowed wait", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    const slow = new HttpClient({
      userAgent: "t",
      timeoutMs: 1000,
      defaultLimit: { intervalMs: 10_000, concurrency: 1 },
      maxQueueWaitMs: 100,
      logger: silentLogger,
    });
    await slow.getText("https://slow.example/1");
    await expect(slow.getText("https://slow.example/2")).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("health", () => {
  it("marks a source degraded after repeated failures", () => {
    const h = new HealthTracker();
    for (let i = 0; i < 4; i++) h.record("biocoop", "parse_error", 100);
    h.record("off", "ok", 50);
    const [biocoop, off] = h.snapshot(["biocoop", "off"]);
    expect(biocoop?.status).toBe("degraded");
    expect(off).toMatchObject({ status: "ok", p50Ms: 50 });
  });
});
