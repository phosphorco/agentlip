import { describe, it, expect } from "bun:test";
import {
  parseBearerToken,
  requireAuth,
  requireWsToken,
} from "./authMiddleware";

const VALID_TOKEN = "abc123def456secret789token000111";
const WRONG_TOKEN = "wrongtoken999888777666555444333";

describe("parseBearerToken", () => {
  it("returns null when Authorization header is missing", () => {
    const req = new Request("http://localhost/test");
    expect(parseBearerToken(req)).toBeNull();
  });

  it("returns null for non-Bearer auth schemes", () => {
    const req = new Request("http://localhost/test", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(parseBearerToken(req)).toBeNull();
  });

  it("returns null for malformed Bearer header (no space)", () => {
    const req = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer" },
    });
    expect(parseBearerToken(req)).toBeNull();
  });

  it("returns null for empty token after Bearer", () => {
    const req = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer    " },
    });
    expect(parseBearerToken(req)).toBeNull();
  });

  it("parses valid Bearer token (case-insensitive Bearer)", () => {
    const req1 = new Request("http://localhost/test", {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(parseBearerToken(req1)).toBe(VALID_TOKEN);

    const req2 = new Request("http://localhost/test", {
      headers: { Authorization: `bearer ${VALID_TOKEN}` },
    });
    expect(parseBearerToken(req2)).toBe(VALID_TOKEN);

    const req3 = new Request("http://localhost/test", {
      headers: { Authorization: `BEARER ${VALID_TOKEN}` },
    });
    expect(parseBearerToken(req3)).toBe(VALID_TOKEN);
  });

  it("handles multiple spaces between Bearer and token", () => {
    const req = new Request("http://localhost/test", {
      headers: { Authorization: `Bearer   ${VALID_TOKEN}` },
    });
    // Per RFC, only one space is standard, but we match one or more
    expect(parseBearerToken(req)).toBe(VALID_TOKEN);
  });
});

describe("requireAuth", () => {
  it("returns 401 with MISSING_AUTH when header is missing", async () => {
    const req = new Request("http://localhost/test");
    const result = requireAuth(req, VALID_TOKEN);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.code).toBe("MISSING_AUTH");
      expect(body.error).toBe("Unauthorized");
      // CRITICAL: response must NOT contain the expected or provided token
      const text = JSON.stringify(body);
      expect(text).not.toContain(VALID_TOKEN);
    }
  });

  it("returns 401 with INVALID_AUTH for wrong token", async () => {
    const req = new Request("http://localhost/test", {
      headers: { Authorization: `Bearer ${WRONG_TOKEN}` },
    });
    const result = requireAuth(req, VALID_TOKEN);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.code).toBe("INVALID_AUTH");
      expect(body.error).toBe("Unauthorized");
      // CRITICAL: response must NOT contain tokens
      const text = JSON.stringify(body);
      expect(text).not.toContain(VALID_TOKEN);
      expect(text).not.toContain(WRONG_TOKEN);
    }
  });

  it("returns ok for correct token", () => {
    const req = new Request("http://localhost/test", {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    const result = requireAuth(req, VALID_TOKEN);

    expect(result.ok).toBe(true);
  });

  it("rejects token with different case (tokens are case-sensitive)", () => {
    const req = new Request("http://localhost/test", {
      headers: { Authorization: `Bearer ${VALID_TOKEN.toUpperCase()}` },
    });
    const result = requireAuth(req, VALID_TOKEN);

    expect(result.ok).toBe(false);
  });
});

describe("requireWsToken", () => {
  it("returns closeCode 4001 when token query param is missing", () => {
    const url = new URL("ws://localhost/ws");
    const result = requireWsToken(url, VALID_TOKEN);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.closeCode).toBe(4001);
      expect(result.closeReason).toBe("Missing authentication token");
      // CRITICAL: close reason must NOT contain the token
      expect(result.closeReason).not.toContain(VALID_TOKEN);
    }
  });

  it("returns closeCode 4001 for empty token param", () => {
    const url = new URL("ws://localhost/ws?token=");
    const result = requireWsToken(url, VALID_TOKEN);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.closeCode).toBe(4001);
    }
  });

  it("returns closeCode 4001 for whitespace-only token param", () => {
    const url = new URL("ws://localhost/ws?token=%20%20%20");
    const result = requireWsToken(url, VALID_TOKEN);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.closeCode).toBe(4001);
    }
  });

  it("returns closeCode 4003 for wrong token", () => {
    const url = new URL(`ws://localhost/ws?token=${WRONG_TOKEN}`);
    const result = requireWsToken(url, VALID_TOKEN);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.closeCode).toBe(4003);
      expect(result.closeReason).toBe("Invalid authentication token");
      // CRITICAL: close reason must NOT contain tokens
      expect(result.closeReason).not.toContain(VALID_TOKEN);
      expect(result.closeReason).not.toContain(WRONG_TOKEN);
    }
  });

  it("returns ok for correct token", () => {
    const url = new URL(`ws://localhost/ws?token=${VALID_TOKEN}`);
    const result = requireWsToken(url, VALID_TOKEN);

    expect(result.ok).toBe(true);
  });

  it("token comparison is case-sensitive", () => {
    const url = new URL(`ws://localhost/ws?token=${VALID_TOKEN.toUpperCase()}`);
    const result = requireWsToken(url, VALID_TOKEN);

    expect(result.ok).toBe(false);
  });

  it("handles URL-encoded token correctly", () => {
    // Simulate a token with special chars that gets URL encoded
    const specialToken = "abc+def=ghi/jkl";
    const url = new URL(`ws://localhost/ws?token=${encodeURIComponent(specialToken)}`);
    const result = requireWsToken(url, specialToken);

    expect(result.ok).toBe(true);
  });
});

describe("security: no token leakage", () => {
  it("HTTP 401 response body does not contain expected token", async () => {
    const sensitiveToken = "SUPER_SECRET_TOKEN_12345";
    const req = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer wrong" },
    });
    const result = requireAuth(req, sensitiveToken);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const bodyText = await result.response.text();
      expect(bodyText).not.toContain(sensitiveToken);
      expect(bodyText).not.toContain("wrong");
    }
  });

  it("HTTP 401 response body does not contain provided token", async () => {
    const providedToken = "USER_PROVIDED_TOKEN_67890";
    const req = new Request("http://localhost/test", {
      headers: { Authorization: `Bearer ${providedToken}` },
    });
    const result = requireAuth(req, "expected_token");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const bodyText = await result.response.text();
      expect(bodyText).not.toContain(providedToken);
      expect(bodyText).not.toContain("expected_token");
    }
  });

  it("WS close reason does not contain expected or provided token", () => {
    const sensitiveToken = "WS_SECRET_TOKEN_ABC";
    const providedToken = "ATTACKER_TOKEN_XYZ";
    const url = new URL(`ws://localhost/ws?token=${providedToken}`);
    const result = requireWsToken(url, sensitiveToken);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.closeReason).not.toContain(sensitiveToken);
      expect(result.closeReason).not.toContain(providedToken);
    }
  });
});
