/**
 * Shared WebSocket protocol types for Agentlip client SDK
 * 
 * These types match the hub's wsEndpoint.ts implementation
 * and are used by both client SDK and CLI.
 */

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Protocol Messages
// ─────────────────────────────────────────────────────────────────────────────

export interface HelloMessage {
  type: "hello";
  after_event_id: number;
  subscriptions?: {
    channels?: string[];
    topics?: string[];
  };
}

export interface HelloOkMessage {
  type: "hello_ok";
  replay_until: number;
  instance_id: string;
}

export interface EventEnvelope {
  type: "event";
  event_id: number;
  ts: string;
  name: string;
  scope: {
    channel_id?: string | null;
    topic_id?: string | null;
    topic_id2?: string | null;
  };
  entity?: {
    type: string;
    id: string;
  };
  data: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server Configuration (server.json)
// ─────────────────────────────────────────────────────────────────────────────

export interface ServerJsonData {
  instance_id: string;
  db_id: string;
  port: number;
  host: string;
  auth_token: string;
  pid: number;
  started_at: string;
  protocol_version: string;
  schema_version?: number;
}
