/**
 * Auth middleware utilities for HTTP mutations + WebSocket token validation.
 * 
 * Security requirements:
 * - All token comparisons use constant-time comparison (prevent timing attacks)
 * - Tokens are NEVER echoed in error responses or logs
 * - Generic error messages that don't leak token info
 */

import { constantTimeEqual } from "./authToken";

/**
 * Parse Bearer token from Authorization header.
 * Returns the token string if valid "Bearer <token>" format, null otherwise.
 * 
 * Does NOT log or include the token in any error state.
 */
export function parseBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return null;
  }

  // Must be "Bearer <token>" format (case-insensitive "Bearer")
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1];
  // Reject empty or whitespace-only tokens
  if (!token || token.trim().length === 0) {
    return null;
  }

  return token;
}

export type AuthOk = { ok: true };
export type AuthFailure = { ok: false; response: Response };
export type AuthResult = AuthOk | AuthFailure;

/**
 * Require valid Bearer token auth for HTTP requests.
 * 
 * Uses constant-time comparison to prevent timing attacks.
 * Returns generic 401 response on failure (no token info leaked).
 * 
 * @param req - Incoming HTTP request
 * @param expectedToken - The valid auth token (from server.json)
 * @returns { ok: true } on success, { ok: false, response: Response } on failure
 */
export function requireAuth(req: Request, expectedToken: string): AuthResult {
  const providedToken = parseBearerToken(req);

  if (providedToken === null) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: "Unauthorized",
          code: "MISSING_AUTH",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      ),
    };
  }

  // Constant-time comparison prevents timing attacks
  if (!constantTimeEqual(providedToken, expectedToken)) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: "Unauthorized",
          code: "INVALID_AUTH",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      ),
    };
  }

  return { ok: true };
}

export type WsAuthOk = { ok: true };
export type WsAuthFailure = { ok: false; closeCode: number; closeReason: string };
export type WsAuthResult = WsAuthOk | WsAuthFailure;

/**
 * Require valid token query param for WebSocket connections.
 * 
 * WebSocket auth uses ?token=<value> query parameter since
 * browsers cannot set custom headers on WebSocket connections.
 * 
 * Uses constant-time comparison to prevent timing attacks.
 * Returns close code/reason on failure (no token info leaked).
 * 
 * Close codes:
 * - 4001: Missing token
 * - 4003: Invalid token (Forbidden)
 * 
 * @param url - WebSocket connection URL
 * @param expectedToken - The valid auth token (from server.json)
 * @returns { ok: true } on success, { ok: false, closeCode, closeReason } on failure
 */
export function requireWsToken(url: URL, expectedToken: string): WsAuthResult {
  const providedToken = url.searchParams.get("token");

  if (providedToken === null || providedToken.trim().length === 0) {
    return {
      ok: false,
      closeCode: 4001,
      closeReason: "Missing authentication token",
    };
  }

  // Constant-time comparison prevents timing attacks
  if (!constantTimeEqual(providedToken, expectedToken)) {
    return {
      ok: false,
      closeCode: 4003,
      closeReason: "Invalid authentication token",
    };
  }

  return { ok: true };
}
