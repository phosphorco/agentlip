/**
 * Input validation and size limit utilities for HTTP and WebSocket.
 *
 * Provides safe JSON body parsing with:
 * - Configurable byte limits
 * - Proper error handling (no user content echoed in errors)
 * - Validation helpers
 *
 * Size limits from plan (0.1.2 Safe Defaults):
 * - HTTP message content: 64KB
 * - Attachment metadata: 16KB
 * - WS message: 256KB
 */

/**
 * Size limit constants (bytes).
 */
export const SIZE_LIMITS = {
  /** Max message content: 64KB */
  MESSAGE_BODY: 64 * 1024,
  /** Max attachment metadata: 16KB */
  ATTACHMENT: 16 * 1024,
  /** Max WebSocket message: 256KB */
  WS_MESSAGE: 256 * 1024,
  /** Default HTTP body limit: 64KB */
  DEFAULT_HTTP: 64 * 1024,
} as const;

/**
 * Options for reading JSON body.
 */
export interface ReadJsonBodyOptions {
  /** Maximum bytes to accept (default: 64KB) */
  maxBytes?: number;
}

/**
 * Result of parsing JSON body.
 */
export type JsonBodyResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; response: Response };

/**
 * Read and parse JSON body from HTTP request with size validation.
 *
 * Security:
 * - Size checked before parsing (DoS protection)
 * - Invalid JSON errors do not echo user content
 * - Generic error messages
 *
 * @param req - HTTP request
 * @param options - Size limit options
 * @returns Parsed JSON or error response
 */
export async function readJsonBody<T = unknown>(
  req: Request,
  options: ReadJsonBodyOptions = {}
): Promise<JsonBodyResult<T>> {
  const maxBytes = options.maxBytes ?? SIZE_LIMITS.DEFAULT_HTTP;

  // Check Content-Length header first (fast path rejection)
  const contentLength = req.headers.get("Content-Length");
  if (contentLength) {
    const length = parseInt(contentLength, 10);
    if (!isNaN(length) && length > maxBytes) {
      return {
        ok: false,
        response: payloadTooLargeResponse(maxBytes),
      };
    }
  }

  // Check Content-Type
  const contentType = req.headers.get("Content-Type");
  if (!contentType || !contentType.includes("application/json")) {
    return {
      ok: false,
      response: invalidContentTypeResponse(),
    };
  }

  try {
    // Read body as ArrayBuffer to check actual size
    const buffer = await req.arrayBuffer();

    if (buffer.byteLength > maxBytes) {
      return {
        ok: false,
        response: payloadTooLargeResponse(maxBytes),
      };
    }

    // Decode and parse JSON
    const text = new TextDecoder().decode(buffer);

    try {
      const data = JSON.parse(text) as T;
      return { ok: true, data };
    } catch {
      return {
        ok: false,
        response: invalidJsonResponse(),
      };
    }
  } catch {
    // Body read error (connection reset, etc.)
    return {
      ok: false,
      response: bodyReadErrorResponse(),
    };
  }
}

/**
 * Validate a WebSocket message size.
 *
 * @param data - Message data (string or binary)
 * @param maxBytes - Maximum allowed bytes (default: 256KB)
 * @returns true if within limit
 */
export function validateWsMessageSize(
  data: string | ArrayBuffer | Uint8Array,
  maxBytes: number = SIZE_LIMITS.WS_MESSAGE
): boolean {
  let size: number;

  if (typeof data === "string") {
    // For strings, use byte length (UTF-8)
    size = new TextEncoder().encode(data).length;
  } else if (data instanceof ArrayBuffer) {
    size = data.byteLength;
  } else {
    size = data.length;
  }

  return size <= maxBytes;
}

/**
 * Parse and validate WebSocket JSON message.
 *
 * @param data - Raw message data
 * @param maxBytes - Maximum allowed bytes
 * @returns Parsed object or null on failure
 */
export function parseWsMessage<T = unknown>(
  data: string | ArrayBuffer | Uint8Array,
  maxBytes: number = SIZE_LIMITS.WS_MESSAGE
): T | null {
  if (!validateWsMessageSize(data, maxBytes)) {
    return null;
  }

  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (data instanceof ArrayBuffer) {
    text = new TextDecoder().decode(data);
  } else {
    text = new TextDecoder().decode(data);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Validate that serialized JSON stays within size limit.
 * Useful for validating attachment value_json before insertion.
 *
 * @param value - Value to check
 * @param maxBytes - Maximum serialized size
 * @returns true if within limit
 */
export function validateJsonSize(value: unknown, maxBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return new TextEncoder().encode(serialized).length <= maxBytes;
  } catch {
    return false;
  }
}

// ============================================================================
// Error response helpers (generic messages, no user content echoed)
// ============================================================================

/**
 * Create 413 Payload Too Large response.
 */
export function payloadTooLargeResponse(maxBytes: number): Response {
  return new Response(
    JSON.stringify({
      error: `Payload too large (max ${Math.floor(maxBytes / 1024)}KB)`,
      code: "PAYLOAD_TOO_LARGE",
    }),
    {
      status: 413,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Create 400 Bad Request response for invalid JSON.
 */
export function invalidJsonResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "Invalid JSON",
      code: "INVALID_INPUT",
    }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Create 415 Unsupported Media Type response.
 */
export function invalidContentTypeResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "Content-Type must be application/json",
      code: "INVALID_INPUT",
    }),
    {
      status: 415,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Create 400 Bad Request response for body read errors.
 */
export function bodyReadErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "Failed to read request body",
      code: "INVALID_INPUT",
    }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * Create generic 400 Bad Request response for validation errors.
 *
 * @param message - Error message (should not contain user input)
 */
export function validationErrorResponse(message: string): Response {
  return new Response(
    JSON.stringify({
      error: message,
      code: "INVALID_INPUT",
    }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }
  );
}
