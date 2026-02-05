export const PROTOCOL_VERSION = "v1" as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type HealthResponse = {
  status: "ok";
  instance_id: string;
  db_id: string;
  schema_version: number;
  protocol_version: ProtocolVersion;
  pid: number;
  uptime_seconds: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Error Codes & Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Standard machine-readable error codes across CLI and HTTP API.
 * Per plan §0.8 Error Code Catalog.
 */
export const ERROR_CODES = {
  INVALID_INPUT: "INVALID_INPUT",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  NOT_FOUND: "NOT_FOUND",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  CROSS_CHANNEL_MOVE: "CROSS_CHANNEL_MOVE",
  UNAUTHORIZED: "UNAUTHORIZED",
  RATE_LIMITED: "RATE_LIMITED",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  HUB_NOT_RUNNING: "HUB_NOT_RUNNING",
  CONNECTION_FAILED: "CONNECTION_FAILED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Standard API error response shape.
 * All errors return this structure for machine-readable parsing.
 */
export interface ApiErrorResponse {
  error: string;
  code: ErrorCode;
  details?: {
    /** For VERSION_CONFLICT: current version */
    current?: number;
    /** For VERSION_CONFLICT: expected version */
    expected?: number;
    /** For RATE_LIMITED: requests allowed per window */
    limit?: number;
    /** For RATE_LIMITED: window duration (e.g., "1s") */
    window?: string;
    /** For RATE_LIMITED: seconds until rate limit resets */
    retry_after?: number;
    /** Additional context */
    [key: string]: unknown;
  };
}

/**
 * Standard CLI exit codes per plan §0.9.
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  GENERAL_ERROR: 1,
  CONFLICT: 2,
  HUB_NOT_RUNNING: 3,
  AUTH_FAILED: 4,
} as const;
