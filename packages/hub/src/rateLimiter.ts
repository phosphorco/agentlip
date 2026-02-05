/**
 * In-memory rate limiter supporting:
 * - Global rate limiting (all requests)
 * - Per-client rate limiting (keyed by auth token or 'anon')
 *
 * Uses token bucket algorithm with configurable window.
 * Thread-safe for single-process usage.
 *
 * Security: client keys derived from auth tokens are never logged.
 */

/**
 * Bucket state for token bucket algorithm.
 */
interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Rate limiter configuration.
 */
export interface RateLimiterConfig {
  /** Max requests per window */
  limit: number;
  /** Window size in milliseconds */
  windowMs: number;
}

/**
 * Rate limit check result.
 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Reset time as Unix timestamp (seconds) */
  resetAt: number;
}

/**
 * In-memory rate limiter using token bucket algorithm.
 */
export class RateLimiter {
  private buckets: Map<string, Bucket> = new Map();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(config: RateLimiterConfig) {
    this.limit = config.limit;
    this.windowMs = config.windowMs;
  }

  /**
   * Check if a request is allowed for the given key.
   * Consumes a token if allowed.
   *
   * @param key - Unique identifier (e.g., 'global' or hashed client key)
   * @returns Rate limit result
   */
  check(key: string): RateLimitResult {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      // Initialize new bucket
      bucket = {
        tokens: this.limit,
        lastRefill: now,
      };
      this.buckets.set(key, bucket);
    }

    // Calculate tokens to add based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = (elapsed / this.windowMs) * this.limit;

    // Refill bucket (capped at limit)
    bucket.tokens = Math.min(this.limit, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    // Calculate reset time (when bucket would be full)
    const tokensNeeded = this.limit - bucket.tokens;
    const msUntilFull = tokensNeeded > 0 ? (tokensNeeded / this.limit) * this.windowMs : 0;
    const resetAt = Math.ceil((now + msUntilFull) / 1000);

    if (bucket.tokens >= 1) {
      // Consume a token
      bucket.tokens -= 1;
      return {
        allowed: true,
        limit: this.limit,
        remaining: Math.floor(bucket.tokens),
        resetAt,
      };
    }

    // Rate limited
    return {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      resetAt,
    };
  }

  /**
   * Clean up expired buckets to prevent memory leaks.
   * Call periodically (e.g., every minute).
   */
  cleanup(): void {
    const now = Date.now();
    const expireAfter = this.windowMs * 2; // Keep buckets for 2x window

    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > expireAfter) {
        this.buckets.delete(key);
      }
    }
  }

  /**
   * Reset all buckets (for testing).
   */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Default rate limiter configurations (from plan).
 */
export const DEFAULT_RATE_LIMITS = {
  /** Per-client rate limit: 100 req/s */
  perClient: { limit: 100, windowMs: 1000 },
  /** Global rate limit: 1000 req/s */
  global: { limit: 1000, windowMs: 1000 },
};

/**
 * Hub rate limiter instance managing both global and per-client limits.
 */
export class HubRateLimiter {
  private globalLimiter: RateLimiter;
  private clientLimiter: RateLimiter;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    globalConfig: RateLimiterConfig = DEFAULT_RATE_LIMITS.global,
    clientConfig: RateLimiterConfig = DEFAULT_RATE_LIMITS.perClient
  ) {
    this.globalLimiter = new RateLimiter(globalConfig);
    this.clientLimiter = new RateLimiter(clientConfig);
  }

  /**
   * Start periodic cleanup of expired buckets.
   * @param intervalMs - Cleanup interval (default: 60s)
   */
  startCleanup(intervalMs = 60000): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => {
      this.globalLimiter.cleanup();
      this.clientLimiter.cleanup();
    }, intervalMs);
  }

  /**
   * Stop cleanup timer.
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Derive a stable client key from request.
   * Uses Authorization header if present, otherwise 'anon'.
   *
   * Security: We hash the token to avoid storing it directly.
   * The key is never logged.
   *
   * @param req - HTTP request
   * @returns Stable client key (never the raw token)
   */
  private getClientKey(req: Request): string {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return "anon";
    }
    // Use a hash of the auth header to create a stable key
    // without storing the actual token
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(authHeader);
    return `client:${hasher.digest("hex").substring(0, 16)}`;
  }

  /**
   * Check rate limits for a request.
   * Checks both global and per-client limits.
   *
   * @param req - HTTP request
   * @returns Combined rate limit result
   */
  check(req: Request): RateLimitResult {
    // Check global limit first
    const globalResult = this.globalLimiter.check("global");
    if (!globalResult.allowed) {
      return globalResult;
    }

    // Check per-client limit
    const clientKey = this.getClientKey(req);
    const clientResult = this.clientLimiter.check(clientKey);

    // Return the more restrictive result
    return {
      allowed: clientResult.allowed,
      limit: clientResult.limit,
      remaining: clientResult.remaining,
      resetAt: clientResult.resetAt,
    };
  }

  /**
   * Reset all rate limiters (for testing).
   */
  reset(): void {
    this.globalLimiter.reset();
    this.clientLimiter.reset();
  }
}

/**
 * Create a 429 Too Many Requests response with standard headers.
 *
 * @param result - Rate limit result
 * @returns HTTP 429 response
 */
export function rateLimitedResponse(result: RateLimitResult): Response {
  const retryAfter = Math.max(0, result.resetAt - Math.floor(Date.now() / 1000));

  return new Response(
    JSON.stringify({
      error: "Rate limit exceeded",
      code: "RATE_LIMITED",
      details: {
        limit: result.limit,
        window: "1s",
        retry_after: retryAfter,
      },
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(result.resetAt),
        "Retry-After": String(retryAfter),
      },
    }
  );
}

/**
 * Add rate limit headers to a successful response.
 *
 * @param response - Original response
 * @param result - Rate limit result
 * @returns Response with rate limit headers
 */
export function addRateLimitHeaders(response: Response, result: RateLimitResult): Response {
  const newHeaders = new Headers(response.headers);
  newHeaders.set("X-RateLimit-Limit", String(result.limit));
  newHeaders.set("X-RateLimit-Remaining", String(result.remaining));
  newHeaders.set("X-RateLimit-Reset", String(result.resetAt));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
