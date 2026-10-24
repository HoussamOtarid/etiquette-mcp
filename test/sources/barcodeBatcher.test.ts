import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../src/infra/http.ts";
import { BarcodeBatcher } from "../../src/sources/barcodeBatcher.ts";

const options = { maxBatch: 50, maxRetries: 3, baseBackoffMs: 5000, maxBackoffMs: 60_000 };

describe("BarcodeBatcher", () => {
  it("coalesces lookups made while a request is in flight", async () => {
    let release: () => void = () => {};
    const fetchOne = vi.fn(
      (code: string) => new Promise<string>((resolve) => (release = () => resolve(`one:${code}`))),
    );
    const fetchMany = vi.fn(
      async (codes: string[]) => new Map(codes.filter((c) => c !== "missing").map((c) => [c, `many:${c}`])),
    );
    const batcher = new BarcodeBatcher(fetchOne, fetchMany, options);

    const first = batcher.lookup("a");
    const others = [batcher.lookup("b"), batcher.lookup("c"), batcher.lookup("b"), batcher.lookup("missing")];
    expect(batcher.queued).toBe(3);
    release();

    expect(await first).toBe("one:a");
    expect(await Promise.all(others)).toEqual(["many:b", "many:c", "many:b", null]);
    expect(fetchOne).toHaveBeenCalledTimes(1);
    expect(fetchMany).toHaveBeenCalledTimes(1);
    expect(fetchMany).toHaveBeenCalledWith(["b", "c", "missing"]);
  });

  it("waits on rate limits, honouring Retry-After, then retries", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const fetchOne = vi
      .fn<(code: string) => Promise<string | null>>()
      .mockRejectedValueOnce(new HttpError(429, "world.openfoodfacts.org", 12_000))
      .mockRejectedValueOnce(new HttpError(503, "world.openfoodfacts.org"))
      .mockResolvedValueOnce("ok");
    const batcher = new BarcodeBatcher(fetchOne, async () => new Map(), { ...options, sleep });

    expect(await batcher.lookup("a")).toBe("ok");
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([12_000, 10_000]);
  });

  it("gives up after the retry limit and on other errors", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const limited = new BarcodeBatcher(
      async () => {
        throw new HttpError(429, "x");
      },
      async () => new Map(),
      { ...options, sleep },
    );
    await expect(limited.lookup("a")).rejects.toBeInstanceOf(HttpError);
    expect(sleep).toHaveBeenCalledTimes(3);

    const broken = new BarcodeBatcher(
      async () => {
        throw new HttpError(500, "x");
      },
      async () => new Map(),
      { ...options, sleep },
    );
    await expect(broken.lookup("a")).rejects.toMatchObject({ status: 500 });
  });
});
