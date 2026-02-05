import { describe, it, expect, beforeEach } from "bun:test";
import { RateLimiter, HubRateLimiter, rateLimitedResponse, addRateLimitHeaders } from "./rateLimiter";

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({ limit: 3, windowMs: 1000 });
  });

  it("allows requests within limit", () => {
    const r1 = limiter.check("test");
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.check("test");
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.check("test");
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("rejects requests over limit", () => {
    limiter.check("test");
    limiter.check("test");
    limiter.check("test");

    const r4 = limiter.check("test");
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
  });

  it("tracks separate keys independently", () => {
    limiter.check("key1");
    limiter.check("key1");
    limiter.check("key1");

    // key1 is exhausted
    const r1 = limiter.check("key1");
    expect(r1.allowed).toBe(false);

    // key2 still has tokens
    const r2 = limiter.check("key2");
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(2);
  });

  it("refills tokens over time", async () => {
    limiter.check("test");
    limiter.check("test");
    limiter.check("test");

    // Exhausted
    expect(limiter.check("test").allowed).toBe(false);

    // Wait for partial refill
    await Bun.sleep(500);

    // Should have ~1.5 tokens
    const r = limiter.check("test");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBeGreaterThanOrEqual(0);
  });

  it("provides resetAt timestamp", () => {
    const r = limiter.check("test");
    expect(r.resetAt).toBeGreaterThan(0);
    expect(r.resetAt).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000) + 2);
  });

  it("reset() clears all buckets", () => {
    limiter.check("test");
    limiter.check("test");
    limiter.check("test");

    expect(limiter.check("test").allowed).toBe(false);

    limiter.reset();

    const r = limiter.check("test");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
  });
});

describe("HubRateLimiter", () => {
  let hubLimiter: HubRateLimiter;

  beforeEach(() => {
    hubLimiter = new HubRateLimiter(
      { limit: 10, windowMs: 1000 }, // global
      { limit: 3, windowMs: 1000 }   // per client
    );
  });

  it("applies per-client limit", () => {
    const req = new Request("http://test/", {
      headers: { Authorization: "Bearer token123" },
    });

    // Use up per-client limit (3)
    hubLimiter.check(req);
    hubLimiter.check(req);
    hubLimiter.check(req);

    const r4 = hubLimiter.check(req);
    expect(r4.allowed).toBe(false);
  });

  it("treats requests without auth as 'anon'", () => {
    const req1 = new Request("http://test/");
    const req2 = new Request("http://test/");

    // Both should share 'anon' bucket
    hubLimiter.check(req1);
    hubLimiter.check(req1);
    hubLimiter.check(req2);

    const r = hubLimiter.check(req2);
    expect(r.allowed).toBe(false);
  });

  it("different tokens get different buckets", () => {
    const req1 = new Request("http://test/", {
      headers: { Authorization: "Bearer token_aaa" },
    });
    const req2 = new Request("http://test/", {
      headers: { Authorization: "Bearer token_bbb" },
    });

    // Exhaust token_aaa
    hubLimiter.check(req1);
    hubLimiter.check(req1);
    hubLimiter.check(req1);
    expect(hubLimiter.check(req1).allowed).toBe(false);

    // token_bbb should still work
    expect(hubLimiter.check(req2).allowed).toBe(true);
  });

  it("enforces global limit across all clients", () => {
    // Create limiter with low global limit
    const limiter = new HubRateLimiter(
      { limit: 5, windowMs: 1000 }, // global
      { limit: 100, windowMs: 1000 } // per client (high)
    );

    const reqs = [
      new Request("http://test/", { headers: { Authorization: "Bearer a" } }),
      new Request("http://test/", { headers: { Authorization: "Bearer b" } }),
      new Request("http://test/", { headers: { Authorization: "Bearer c" } }),
    ];

    // Distribute requests across clients
    limiter.check(reqs[0]);
    limiter.check(reqs[1]);
    limiter.check(reqs[2]);
    limiter.check(reqs[0]);
    limiter.check(reqs[1]);

    // Global limit (5) should be hit
    const r = limiter.check(reqs[2]);
    expect(r.allowed).toBe(false);
  });

  it("reset() clears all state", () => {
    const req = new Request("http://test/", {
      headers: { Authorization: "Bearer token" },
    });

    hubLimiter.check(req);
    hubLimiter.check(req);
    hubLimiter.check(req);
    expect(hubLimiter.check(req).allowed).toBe(false);

    hubLimiter.reset();
    expect(hubLimiter.check(req).allowed).toBe(true);
  });
});

describe("rateLimitedResponse", () => {
  it("returns 429 with proper headers", () => {
    const result = {
      allowed: false,
      limit: 100,
      remaining: 0,
      resetAt: Math.floor(Date.now() / 1000) + 60,
    };

    const response = rateLimitedResponse(result);

    expect(response.status).toBe(429);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("Retry-After")).toBeDefined();
  });

  it("includes proper JSON body", async () => {
    const result = { allowed: false, limit: 100, remaining: 0, resetAt: 0 };
    const response = rateLimitedResponse(result);
    const body = await response.json();

    expect(body.error).toBe("Rate limit exceeded");
    expect(body.code).toBe("RATE_LIMITED");
  });
});

describe("addRateLimitHeaders", () => {
  it("adds headers to existing response", () => {
    const original = Response.json({ ok: true });
    const result = {
      allowed: true,
      limit: 100,
      remaining: 50,
      resetAt: Math.floor(Date.now() / 1000) + 30,
    };

    const response = addRateLimitHeaders(original, result);

    expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("50");
    expect(response.headers.get("X-RateLimit-Reset")).toBeDefined();
  });
});
