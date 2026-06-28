import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../rate-limiter.js";

describe("RateLimiter — pre-call gate behavior", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests within limit", () => {
    expect(limiter.check("user-1").allowed).toBe(true);
    expect(limiter.check("user-1").allowed).toBe(true);
    expect(limiter.check("user-1").allowed).toBe(true);
  });

  it("blocks requests when limit exceeded", () => {
    limiter.check("user-1");
    limiter.check("user-1");
    limiter.check("user-1");
    const result = limiter.check("user-1");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.message).toContain("Rate limit exceeded");
  });

  it("returns correct remaining count", () => {
    expect(limiter.check("user-1").remaining).toBe(2);
    expect(limiter.check("user-1").remaining).toBe(1);
    expect(limiter.check("user-1").remaining).toBe(0);
  });

  it("tracks different keys independently", () => {
    limiter.check("user-a");
    limiter.check("user-a");
    limiter.check("user-b");
    expect(limiter.check("user-a").remaining).toBe(0);
    expect(limiter.check("user-b").remaining).toBe(1);
  });

  it("reset clears a key's counter", () => {
    limiter.check("user-1");
    limiter.check("user-1");
    limiter.check("user-1");
    expect(limiter.check("user-1").allowed).toBe(false);
    limiter.reset("user-1");
    expect(limiter.check("user-1").allowed).toBe(true);
  });

  it("gate blocks before external call when limit exceeded", () => {
    // Simulate the meta-api.ts pre-call gate pattern synchronously
    let fetchCallCount = 0;
    function simulatedFetch(key: string) {
      return { called: ++fetchCallCount };
    }

    function gate(key: string) {
      const limit = limiter.check(key);
      if (!limit.allowed) {
        return { error: "rate_limited", blocked: true };
      }
      return simulatedFetch(key);
    }

    expect(gate("api-1")).toEqual({ called: 1 });
    expect(gate("api-1")).toEqual({ called: 2 });
    expect(gate("api-1")).toEqual({ called: 3 });
    // Fourth call blocked by gate — fetch NOT called
    const result = gate("api-1");
    expect(result).toEqual({ error: "rate_limited", blocked: true });
    expect(fetchCallCount).toBe(3); // fetch was never called for 4th request
  });
});
