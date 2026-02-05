/**
 * Plugin runtime harness (Worker-based) with RPC, timeouts, and circuit breaker.
 * 
 * Implements bd-16d.4.3: isolates plugin execution in Bun Workers, enforces wall-clock timeouts,
 * and implements circuit breaker to skip broken plugins after repeated failures.
 * 
 * Plan references:
 * - Plugin contract (v1): Worker-based isolation, 5s default timeout
 * - ADR-0005: Worker isolation by default
 * - Gate E: plugin hangs bounded by timeout; hub continues ingesting messages
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PluginType = "extractor" | "linkifier";

export interface MessageInput {
  id: string;
  content_raw: string;
  sender: string;
  topic_id: string;
  channel_id: string;
  created_at: string;
}

export interface EnrichInput {
  message: MessageInput;
  config: Record<string, unknown>;
}

export interface ExtractInput {
  message: MessageInput;
  config: Record<string, unknown>;
}

export interface Enrichment {
  kind: string;
  span: { start: number; end: number };
  data: Record<string, unknown>;
}

export interface Attachment {
  kind: string;
  key?: string;
  value_json: Record<string, unknown>;
  dedupe_key?: string;
}

export interface RunPluginOptions {
  type: PluginType;
  modulePath: string;
  input: EnrichInput | ExtractInput;
  timeoutMs?: number;
  pluginName?: string; // For circuit breaker tracking
}

export type PluginResult<T> = 
  | { ok: true; data: T }
  | { ok: false; error: string; code: PluginErrorCode };

export type PluginErrorCode = 
  | "TIMEOUT"
  | "WORKER_CRASH"
  | "INVALID_OUTPUT"
  | "CIRCUIT_OPEN"
  | "LOAD_ERROR"
  | "EXECUTION_ERROR";

// ─────────────────────────────────────────────────────────────────────────────
// Circuit Breaker
// ─────────────────────────────────────────────────────────────────────────────

interface CircuitBreakerState {
  failureCount: number;
  lastFailureAt: number;
  state: "closed" | "open";
  openedAt: number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000; // 1 minute

export class CircuitBreaker {
  private readonly states = new Map<string, CircuitBreakerState>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options?: {
    failureThreshold?: number;
    cooldownMs?: number;
  }) {
    this.failureThreshold = options?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /**
   * Check if plugin is allowed to execute.
   * If circuit is open and cooldown expired, transitions to closed.
   */
  isAllowed(pluginName: string): boolean {
    const state = this.states.get(pluginName);
    if (!state || state.state === "closed") {
      return true;
    }

    // Circuit is open - check if cooldown expired
    const now = Date.now();
    const elapsedSinceOpen = now - state.openedAt;
    
    if (elapsedSinceOpen >= this.cooldownMs) {
      // Cooldown expired - reset to closed
      this.states.set(pluginName, {
        failureCount: 0,
        lastFailureAt: 0,
        state: "closed",
        openedAt: 0,
      });
      return true;
    }

    return false;
  }

  /**
   * Record a failure. Opens circuit if threshold exceeded.
   */
  recordFailure(pluginName: string): void {
    const now = Date.now();
    const state = this.states.get(pluginName) ?? {
      failureCount: 0,
      lastFailureAt: 0,
      state: "closed" as const,
      openedAt: 0,
    };

    const newFailureCount = state.failureCount + 1;
    const newState: CircuitBreakerState = {
      failureCount: newFailureCount,
      lastFailureAt: now,
      state: newFailureCount >= this.failureThreshold ? "open" : "closed",
      openedAt: newFailureCount >= this.failureThreshold ? now : state.openedAt,
    };

    this.states.set(pluginName, newState);
  }

  /**
   * Record a success. Resets failure count.
   */
  recordSuccess(pluginName: string): void {
    this.states.set(pluginName, {
      failureCount: 0,
      lastFailureAt: 0,
      state: "closed",
      openedAt: 0,
    });
  }

  /**
   * Get current state for a plugin (for observability).
   */
  getState(pluginName: string): CircuitBreakerState | null {
    return this.states.get(pluginName) ?? null;
  }

  /**
   * Reset all circuit breakers (for testing).
   */
  reset(): void {
    this.states.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Worker RPC Protocol
// ─────────────────────────────────────────────────────────────────────────────

interface WorkerRequest {
  type: PluginType;
  input: EnrichInput | ExtractInput;
}

interface WorkerResponse {
  ok: true;
  data: Enrichment[] | Attachment[];
}

interface WorkerError {
  ok: false;
  error: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin Runner
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Global circuit breaker instance (shared across all plugin executions).
 */
const globalCircuitBreaker = new CircuitBreaker();

/**
 * Execute a plugin in a Bun Worker with timeout and circuit breaker protection.
 * 
 * Features:
 * - Spawns Worker with plugin module
 * - Enforces wall-clock timeout (terminates Worker on timeout)
 * - Circuit breaker: skips execution if plugin has failed repeatedly
 * - RPC request/response protocol
 * - Output validation
 * 
 * @param options Plugin execution options
 * @returns Plugin result (success with data or error with code)
 */
export async function runPlugin<T extends Enrichment[] | Attachment[]>(
  options: RunPluginOptions
): Promise<PluginResult<T>> {
  const {
    type,
    modulePath,
    input,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pluginName = modulePath,
  } = options;

  // Circuit breaker check
  if (!globalCircuitBreaker.isAllowed(pluginName)) {
    const state = globalCircuitBreaker.getState(pluginName);
    const cooldownRemaining = state
      ? Math.ceil((DEFAULT_COOLDOWN_MS - (Date.now() - state.openedAt)) / 1000)
      : 0;

    return {
      ok: false,
      error: `Circuit breaker open for ${pluginName} (${state?.failureCount} failures, ${cooldownRemaining}s cooldown remaining)`,
      code: "CIRCUIT_OPEN",
    };
  }

  let worker: Worker | null = null;

  try {
    // Spawn Worker with plugin module
    worker = new Worker(new URL("./pluginWorker.ts", import.meta.url).href, {
      type: "module",
    });

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Plugin execution timeout"));
      }, timeoutMs);
    });

    // Create result promise
    const resultPromise = new Promise<T>((resolve, reject) => {
      worker!.onmessage = (event: MessageEvent) => {
        const response = event.data as WorkerResponse | WorkerError;
        
        if (response.ok) {
          resolve(response.data as T);
        } else {
          reject(new Error(response.error));
        }
      };

      worker!.onerror = (error: ErrorEvent) => {
        reject(new Error(`Worker error: ${error.message}`));
      };
    });

    // Send RPC request to worker
    const request: WorkerRequest = { type, input };
    worker.postMessage({ modulePath, request });

    // Race between result and timeout
    const data = await Promise.race([resultPromise, timeoutPromise]);

    // Validate output
    const validationError = validatePluginOutput(type, data);
    if (validationError) {
      globalCircuitBreaker.recordFailure(pluginName);
      return {
        ok: false,
        error: validationError,
        code: "INVALID_OUTPUT",
      };
    }

    // Success - reset circuit breaker
    globalCircuitBreaker.recordSuccess(pluginName);

    return { ok: true, data };
  } catch (error: any) {
    // Record failure
    globalCircuitBreaker.recordFailure(pluginName);

    // Classify error
    if (error.message === "Plugin execution timeout") {
      return {
        ok: false,
        error: `Plugin timed out after ${timeoutMs}ms`,
        code: "TIMEOUT",
      };
    }

    if (error.message?.includes("Worker error")) {
      return {
        ok: false,
        error: error.message,
        code: "WORKER_CRASH",
      };
    }

    return {
      ok: false,
      error: error.message ?? "Unknown error",
      code: "EXECUTION_ERROR",
    };
  } finally {
    // Always terminate worker
    if (worker) {
      worker.terminate();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Output Validation
// ─────────────────────────────────────────────────────────────────────────────

function validatePluginOutput(
  type: PluginType,
  output: unknown
): string | null {
  if (!Array.isArray(output)) {
    return "Output must be an array";
  }

  if (type === "linkifier") {
    for (const item of output) {
      if (!isValidEnrichment(item)) {
        return `Invalid enrichment: ${JSON.stringify(item)}`;
      }
    }
  } else if (type === "extractor") {
    for (const item of output) {
      if (!isValidAttachment(item)) {
        return `Invalid attachment: ${JSON.stringify(item)}`;
      }
    }
  }

  return null;
}

function isValidEnrichment(obj: unknown): obj is Enrichment {
  if (typeof obj !== "object" || obj === null) return false;
  const e = obj as any;
  
  return (
    typeof e.kind === "string" &&
    e.kind.trim().length > 0 &&
    typeof e.span === "object" &&
    e.span !== null &&
    typeof e.span.start === "number" &&
    typeof e.span.end === "number" &&
    e.span.start >= 0 &&
    e.span.end >= e.span.start &&
    typeof e.data === "object" &&
    e.data !== null &&
    !Array.isArray(e.data)
  );
}

function isValidAttachment(obj: unknown): obj is Attachment {
  if (typeof obj !== "object" || obj === null) return false;
  const a = obj as any;
  
  return (
    typeof a.kind === "string" &&
    a.kind.trim().length > 0 &&
    (a.key === undefined || typeof a.key === "string") &&
    typeof a.value_json === "object" &&
    a.value_json !== null &&
    !Array.isArray(a.value_json) &&
    (a.dedupe_key === undefined || typeof a.dedupe_key === "string")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports (for testing and hub integration)
// ─────────────────────────────────────────────────────────────────────────────

export { globalCircuitBreaker };
