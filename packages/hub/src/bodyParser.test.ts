import { describe, it, expect } from "bun:test";
import {
  readJsonBody,
  validateWsMessageSize,
  parseWsMessage,
  validateJsonSize,
  SIZE_LIMITS,
} from "./bodyParser";

describe("readJsonBody", () => {
  it("parses valid JSON body", async () => {
    const req = new Request("http://test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });

    const result = await readJsonBody(req);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ foo: "bar" });
    }
  });

  it("rejects missing Content-Type", async () => {
    const req = new Request("http://test/", {
      method: "POST",
      body: JSON.stringify({ foo: "bar" }),
    });

    const result = await readJsonBody(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(415);
    }
  });

  it("rejects wrong Content-Type", async () => {
    const req = new Request("http://test/", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    });

    const result = await readJsonBody(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(415);
    }
  });

  it("rejects oversized body (Content-Length check)", async () => {
    const largeBody = "x".repeat(1000);
    const req = new Request("http://test/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(largeBody.length),
      },
      body: largeBody,
    });

    const result = await readJsonBody(req, { maxBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
      const body = await result.response.json();
      expect(body.code).toBe("PAYLOAD_TOO_LARGE");
    }
  });

  it("rejects oversized body (actual size check)", async () => {
    // Body larger than limit but no Content-Length header
    const largeBody = JSON.stringify({ data: "x".repeat(1000) });
    const req = new Request("http://test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: largeBody,
    });

    const result = await readJsonBody(req, { maxBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
    }
  });

  it("rejects invalid JSON", async () => {
    const req = new Request("http://test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ invalid json }",
    });

    const result = await readJsonBody(req);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.code).toBe("INVALID_INPUT");
      expect(body.error).toBe("Invalid JSON");
      // Ensure invalid content not echoed
      expect(JSON.stringify(body)).not.toContain("invalid json");
    }
  });

  it("uses default size limit", async () => {
    // Body within default limit (64KB)
    const smallBody = JSON.stringify({ small: true });
    const req = new Request("http://test/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: smallBody,
    });

    const result = await readJsonBody(req);
    expect(result.ok).toBe(true);
  });
});

describe("validateWsMessageSize", () => {
  it("accepts message within limit", () => {
    expect(validateWsMessageSize("hello", 1000)).toBe(true);
  });

  it("rejects message over limit", () => {
    expect(validateWsMessageSize("x".repeat(100), 50)).toBe(false);
  });

  it("handles ArrayBuffer", () => {
    const buffer = new TextEncoder().encode("hello").buffer;
    expect(validateWsMessageSize(buffer, 1000)).toBe(true);
    expect(validateWsMessageSize(buffer, 3)).toBe(false);
  });

  it("handles Uint8Array", () => {
    const arr = new TextEncoder().encode("hello");
    expect(validateWsMessageSize(arr, 1000)).toBe(true);
    expect(validateWsMessageSize(arr, 3)).toBe(false);
  });

  it("uses default WS limit", () => {
    // Just under 256KB should be fine
    const smallMessage = "x".repeat(250 * 1024);
    expect(validateWsMessageSize(smallMessage)).toBe(true);

    // Over 256KB should fail
    const largeMessage = "x".repeat(300 * 1024);
    expect(validateWsMessageSize(largeMessage)).toBe(false);
  });
});

describe("parseWsMessage", () => {
  it("parses valid JSON string", () => {
    const result = parseWsMessage<{ foo: string }>(JSON.stringify({ foo: "bar" }));
    expect(result).toEqual({ foo: "bar" });
  });

  it("returns null for invalid JSON", () => {
    const result = parseWsMessage("not json");
    expect(result).toBeNull();
  });

  it("returns null for oversized message", () => {
    const large = JSON.stringify({ data: "x".repeat(1000) });
    const result = parseWsMessage(large, 100);
    expect(result).toBeNull();
  });

  it("handles ArrayBuffer input", () => {
    const buffer = new TextEncoder().encode(JSON.stringify({ ok: true })).buffer;
    const result = parseWsMessage<{ ok: boolean }>(buffer);
    expect(result).toEqual({ ok: true });
  });
});

describe("validateJsonSize", () => {
  it("accepts JSON within limit", () => {
    expect(validateJsonSize({ small: true }, 1000)).toBe(true);
  });

  it("rejects JSON over limit", () => {
    const large = { data: "x".repeat(1000) };
    expect(validateJsonSize(large, 100)).toBe(false);
  });

  it("handles non-serializable values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(validateJsonSize(circular, 1000)).toBe(false);
  });
});

describe("SIZE_LIMITS", () => {
  it("has expected values", () => {
    expect(SIZE_LIMITS.MESSAGE_BODY).toBe(64 * 1024);
    expect(SIZE_LIMITS.ATTACHMENT).toBe(16 * 1024);
    expect(SIZE_LIMITS.WS_MESSAGE).toBe(256 * 1024);
  });
});
