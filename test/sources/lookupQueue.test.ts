import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../src/infra/http.ts";
import { LookupQueue } from "../../src/sources/lookupQueue.ts";

const options = { maxRetries: 3, baseBackoffMs: 5000, maxBackoffMs: 60_000 };

describe("LookupQueue", () => {
  it("runs one lookup at a time and shares concurrent lookups of the same key", async () => {
    let running = 0;
    let maxRunning = 0;
    const fetch = vi.fn(async (key: string) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return key === "missing" ? null : `value-${key}`;
    });
    const queue = new LookupQueue(fetch, options);
    const results = await Promise.all(["a", "b", "a", "missing", "b"].map((k) => queue.lookup(k)));
    expect(results).toEqual(["value-a", "value-b", "value-a", null, "value-b"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(maxRunning).toBe(1);
  });

  it("waits and retries when rate limited, honouring Retry-After", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let calls = 0;
    const fetch = async () => {
      calls++;
      if (calls === 1) throw new HttpError(429, "x", 7000);
      if (calls === 2) throw new HttpError(503, "x");
      return "ok";
    };
    const queue = new LookupQueue(fetch, { ...options, sleep });
    expect(await queue.lookup("a")).toBe("ok");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([7000, 10_000]);
  });

  it("gives up after the retries and does not retry other errors, without blocking later lookups", async () => {
    const limited = new LookupQueue(
      async () => {
        throw new HttpError(503, "x");
      },
      { ...options, maxRetries: 2, sleep: async () => {} },
    );
    await expect(limited.lookup("a")).rejects.toBeInstanceOf(HttpError);
    let calls = 0;
    const broken = new LookupQueue(
      async (key: string) => {
        calls++;
        if (key === "bad") throw new Error("parse error");
        return key;
      },
      { ...options, sleep: async () => {} },
    );
    await expect(broken.lookup("bad")).rejects.toThrow("parse error");
    expect(calls).toBe(1);
    expect(await broken.lookup("good")).toBe("good");
  });
});
