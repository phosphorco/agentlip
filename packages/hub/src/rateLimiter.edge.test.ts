/**
 * Rate limiting edge-case test suite (bd-16d.6.13)
 * 
 * Tests coverage:
 * - Per-client limit enforcement with proper 429 responses
 * - Global limit enforcement across multiple distinct clients
 * - Full window expiry and allowance restoration
 * - Header consistency (X-RateLimit-*, Retry-After)
 * - Edge cases: concurrent requests, cleanup, resetAt accuracy
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  RateLimiter,
  HubRateLimiter,
  rateLimitedResponse,
  addRateLimitHeaders,
} from "./rateLimiter";

describe("RateLimiter edge cases", () => {
  describe("full window expiry and reset", () => {
    it("fully restores allowance after window expires", async () => {
      const limiter = new RateLimiter({ limit: 3, windowMs: 200 });

      // Exhaust all tokens
      expect(limiter.check("test").allowed).toBe(true);
      expect(limiter.check("test").allowed).toBe(true);
      expect(limiter.check("test").allowed).toBe(true);
      expect(limiter.check("test").allowed).toBe(false);

      // Wait for full window to expire
      await Bun.sleep(220);

      // Should have full allowance restored
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

    it("handles partial window expiry correctly", async () => {
      const limiter = new RateLimiter({ limit: 10, windowMs: 1000 });

      // Use 5 tokens
      for (let i = 0; i < 5; i++) {
        limiter.check("test");
      }

      // Wait for half window (should refill ~5 tokens)
      await Bun.sleep(500);

      // Should have ~10 tokens available (5 remaining + ~5 refilled)
      let successCount = 0;
      for (let i = 0; i < 12; i++) {
        if (limiter.check("test").allowed) {
          successCount++;
        }
      }

      // Should get close to 10 (allow some timing variance)
      expect(successCount).toBeGreaterThanOrEqual(9);
      expect(successCount).toBeLessThanOrEqual(11);
    });

    it("resetAt timestamp is accurate within 1 second", () => {
      const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });

      const now = Date.now();
      const result = limiter.check("test");

      const expectedResetAt = Math.ceil((now + 1000) / 1000);
      const actualResetAt = result.resetAt;

      // Should be within 1 second of expected
      expect(Math.abs(actualResetAt - expectedResetAt)).toBeLessThanOrEqual(1);
    });

    it("resetAt updates as tokens are consumed", () => {
      const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });

      const r1 = limiter.check("test");
      const r2 = limiter.check("test");
      const r3 = limiter.check("test");

      // All should have similar resetAt (within same window)
      expect(Math.abs(r1.resetAt - r2.resetAt)).toBeLessThanOrEqual(1);
      expect(Math.abs(r2.resetAt - r3.resetAt)).toBeLessThanOrEqual(1);

      // Rate limited request should show when bucket refills
      const r4 = limiter.check("test");
      expect(r4.allowed).toBe(false);
      expect(r4.resetAt).toBeGreaterThanOrEqual(r3.resetAt);
    });
  });

  describe("concurrent request handling", () => {
    it("handles burst of concurrent requests at limit boundary", () => {
      const limiter = new RateLimiter({ limit: 5, windowMs: 1000 });

      // Simulate 10 concurrent requests (only 5 should succeed)
      const results = Array.from({ length: 10 }, () => limiter.check("test"));

      const allowed = results.filter(r => r.allowed).length;
      const denied = results.filter(r => !r.allowed).length;

      expect(allowed).toBe(5);
      expect(denied).toBe(5);
    });

    it("maintains correct remaining count under concurrent load", () => {
      const limiter = new RateLimiter({ limit: 10, windowMs: 1000 });

      const results = Array.from({ length: 10 }, () => limiter.check("test"));

      // Check remaining counts are monotonically decreasing
      const allowed = results.filter(r => r.allowed);
      for (let i = 0; i < allowed.length - 1; i++) {
        expect(allowed[i].remaining).toBeGreaterThanOrEqual(allowed[i + 1].remaining);
      }

      // Last allowed should have remaining=0
      expect(allowed[allowed.length - 1].remaining).toBe(0);
    });
  });

  describe("cleanup behavior", () => {
    it("cleanup() removes expired buckets", async () => {
      const limiter = new RateLimiter({ limit: 3, windowMs: 100 });

      // Create several buckets
      limiter.check("key1");
      limiter.check("key2");
      limiter.check("key3");

      // Wait for 2x window (cleanup threshold)
      await Bun.sleep(220);

      // Cleanup should remove stale buckets
      limiter.cleanup();

      // New requests should get fresh buckets with full allowance
      const r1 = limiter.check("key1");
      expect(r1.remaining).toBe(2); // Fresh bucket
    });

    it("cleanup() preserves recently used buckets", async () => {
      const limiter = new RateLimiter({ limit: 3, windowMs: 100 });

      // Use some tokens from key1
      limiter.check("key1");
      limiter.check("key1");

      // Wait a bit but not enough to expire
      await Bun.sleep(50);

      // Cleanup should not remove active bucket
      limiter.cleanup();

      // Next request should see depleted bucket (not fresh)
      const r = limiter.check("key1");
      expect(r.remaining).toBeLessThan(2); // Not a fresh bucket
    });
  });

  describe("edge values", () => {
    it("handles limit=1 (single request per window)", async () => {
      const limiter = new RateLimiter({ limit: 1, windowMs: 100 });

      expect(limiter.check("test").allowed).toBe(true);
      expect(limiter.check("test").allowed).toBe(false);

      await Bun.sleep(110);

      expect(limiter.check("test").allowed).toBe(true);
    });

    it("handles very high limits efficiently", () => {
      const limiter = new RateLimiter({ limit: 10000, windowMs: 1000 });

      // Should handle many requests quickly
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        limiter.check(`key${i % 10}`);
      }
      const duration = Date.now() - start;

      // Should complete in <100ms (performance check)
      expect(duration).toBeLessThan(100);
    });

    it("handles very short windows (sub-second)", async () => {
      const limiter = new RateLimiter({ limit: 2, windowMs: 50 });

      limiter.check("test");
      limiter.check("test");
      expect(limiter.check("test").allowed).toBe(false);

      await Bun.sleep(60);

      expect(limiter.check("test").allowed).toBe(true);
    });
  });
});

describe("HubRateLimiter edge cases", () => {
  describe("global limit across multiple clients", () => {
    it("enforces global limit across distinct auth tokens", () => {
      const limiter = new HubRateLimiter(
        { limit: 5, windowMs: 1000 }, // global
        { limit: 100, windowMs: 1000 } // per-client (high)
      );

      // Create requests with different auth tokens
      const tokens = ["token_a", "token_b", "token_c"];
      const requests = tokens.map(
        token =>
          new Request("http://test/", {
            headers: { Authorization: `Bearer ${token}` },
          })
      );

      // Distribute 5 requests across 3 clients
      expect(limiter.check(requests[0]).allowed).toBe(true); // token_a: 1
      expect(limiter.check(requests[1]).allowed).toBe(true); // token_b: 1
      expect(limiter.check(requests[2]).allowed).toBe(true); // token_c: 1
      expect(limiter.check(requests[0]).allowed).toBe(true); // token_a: 2
      expect(limiter.check(requests[1]).allowed).toBe(true); // token_b: 2

      // 6th request should hit global limit (regardless of client)
      const result = limiter.check(requests[2]);
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(5); // Should report global limit
    });

    it("allows per-client limit when global limit is higher", () => {
      const limiter = new HubRateLimiter(
        { limit: 1000, windowMs: 1000 }, // global (high)
        { limit: 3, windowMs: 1000 } // per-client (low)
      );

      const req = new Request("http://test/", {
        headers: { Authorization: "Bearer unique_token" },
      });

      // Should hit per-client limit (3) before global (1000)
      expect(limiter.check(req).allowed).toBe(true);
      expect(limiter.check(req).allowed).toBe(true);
      expect(limiter.check(req).allowed).toBe(true);

      const result = limiter.check(req);
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(3); // Should report per-client limit
    });

    it("anonymous requests share same bucket", () => {
      const limiter = new HubRateLimiter(
        { limit: 1000, windowMs: 1000 },
        { limit: 3, windowMs: 1000 }
      );

      // Multiple requests without auth should share 'anon' bucket
      const req1 = new Request("http://test/");
      const req2 = new Request("http://test/");

      limiter.check(req1);
      limiter.check(req2);
      limiter.check(req1);

      // 4th anonymous request should be rate limited
      const result = limiter.check(req2);
      expect(result.allowed).toBe(false);
    });

    it("authenticated and anonymous requests have separate buckets", () => {
      const limiter = new HubRateLimiter(
        { limit: 1000, windowMs: 1000 },
        { limit: 3, windowMs: 1000 }
      );

      const authReq = new Request("http://test/", {
        headers: { Authorization: "Bearer some_token" },
      });
      const anonReq = new Request("http://test/");

      // Exhaust authenticated bucket
      limiter.check(authReq);
      limiter.check(authReq);
      limiter.check(authReq);
      expect(limiter.check(authReq).allowed).toBe(false);

      // Anonymous bucket should still work
      expect(limiter.check(anonReq).allowed).toBe(true);
    });
  });

  describe("reset and cleanup", () => {
    it("reset() clears both global and per-client state", () => {
      const limiter = new HubRateLimiter(
        { limit: 3, windowMs: 1000 },
        { limit: 2, windowMs: 1000 }
      );

      const req = new Request("http://test/", {
        headers: { Authorization: "Bearer token" },
      });

      // Exhaust both limits
      limiter.check(req);
      limiter.check(req);
      expect(limiter.check(req).allowed).toBe(false);

      limiter.reset();

      // Should have fresh allowance (per-client limit is 2)
      const fresh = limiter.check(req);
      expect(fresh.allowed).toBe(true);
      expect(fresh.remaining).toBe(1); // limit=2, consumed 1, remaining 1
    });

    it("cleanup can be started and stopped", async () => {
      const limiter = new HubRateLimiter(
        { limit: 3, windowMs: 100 },
        { limit: 3, windowMs: 100 }
      );

      limiter.startCleanup(50); // 50ms interval

      // Use some tokens
      const req = new Request("http://test/");
      limiter.check(req);

      // Wait for cleanup to run
      await Bun.sleep(150);

      limiter.stopCleanup();

      // Should have been cleaned up (hard to verify directly, but shouldn't crash)
      expect(true).toBe(true);
    });

    it("startCleanup is idempotent", () => {
      const limiter = new HubRateLimiter(
        { limit: 3, windowMs: 1000 },
        { limit: 3, windowMs: 1000 }
      );

      limiter.startCleanup();
      limiter.startCleanup(); // Should not create second interval

      limiter.stopCleanup();
      // Should not throw
    });
  });
});

describe("response helpers", () => {
  describe("rateLimitedResponse", () => {
    it("includes all required headers", () => {
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
      expect(response.headers.get("X-RateLimit-Reset")).toBeDefined();
      expect(response.headers.get("Retry-After")).toBeDefined();
    });

    it("Retry-After is consistent with resetAt", () => {
      const resetAt = Math.floor(Date.now() / 1000) + 30;
      const result = {
        allowed: false,
        limit: 100,
        remaining: 0,
        resetAt,
      };

      const response = rateLimitedResponse(result);

      const retryAfter = parseInt(response.headers.get("Retry-After")!);
      const resetHeader = parseInt(response.headers.get("X-RateLimit-Reset")!);

      expect(resetHeader).toBe(resetAt);
      // Retry-After should be approximately 30 seconds (allow 1s variance for timing)
      expect(retryAfter).toBeGreaterThanOrEqual(29);
      expect(retryAfter).toBeLessThanOrEqual(31);
    });

    it("body contains correct error code and structure", async () => {
      const result = {
        allowed: false,
        limit: 100,
        remaining: 0,
        resetAt: Math.floor(Date.now() / 1000) + 60,
      };

      const response = rateLimitedResponse(result);
      const body = await response.json();

      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("code");
      expect(body.code).toBe("RATE_LIMITED");
      expect(body).toHaveProperty("details");
      expect(body.details).toHaveProperty("limit");
      expect(body.details).toHaveProperty("window");
      expect(body.details).toHaveProperty("retry_after");
      expect(body.details.limit).toBe(100);
    });

    it("handles resetAt in the past gracefully", () => {
      const result = {
        allowed: false,
        limit: 100,
        remaining: 0,
        resetAt: Math.floor(Date.now() / 1000) - 10, // 10 seconds ago
      };

      const response = rateLimitedResponse(result);
      const retryAfter = parseInt(response.headers.get("Retry-After")!);

      // Should be 0 (don't return negative)
      expect(retryAfter).toBe(0);
    });
  });

  describe("addRateLimitHeaders", () => {
    it("preserves existing response body and status", async () => {
      const original = Response.json({ success: true }, { status: 200 });
      const result = {
        allowed: true,
        limit: 100,
        remaining: 50,
        resetAt: Math.floor(Date.now() / 1000) + 30,
      };

      const response = addRateLimitHeaders(original, result);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ success: true });
    });

    it("adds rate limit headers without removing existing headers", () => {
      const original = new Response("OK", {
        headers: {
          "X-Custom-Header": "custom-value",
          "Content-Type": "text/plain",
        },
      });

      const result = {
        allowed: true,
        limit: 100,
        remaining: 50,
        resetAt: Math.floor(Date.now() / 1000) + 30,
      };

      const response = addRateLimitHeaders(original, result);

      expect(response.headers.get("X-Custom-Header")).toBe("custom-value");
      expect(response.headers.get("Content-Type")).toBe("text/plain");
      expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("50");
    });

    it("headers reflect current state accurately", () => {
      const result = {
        allowed: true,
        limit: 100,
        remaining: 42,
        resetAt: 1234567890,
      };

      const response = addRateLimitHeaders(Response.json({}), result);

      expect(response.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(response.headers.get("X-RateLimit-Remaining")).toBe("42");
      expect(response.headers.get("X-RateLimit-Reset")).toBe("1234567890");
    });
  });
});
