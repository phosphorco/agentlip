import { randomBytes } from "node:crypto";

/**
 * Generate a cryptographically random auth token.
 * 
 * Generates >=128-bit entropy token (32 bytes = 256 bits).
 * Returns 64-character hex string.
 * 
 * Never log this token.
 */
export function generateAuthToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Constant-time string comparison helper for auth token validation.
 * Prevents timing attacks.
 * 
 * Returns true if strings are equal, false otherwise.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
