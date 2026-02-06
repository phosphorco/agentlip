#!/usr/bin/env bun
/**
 * agentlip CLI - stateless read-only queries and hub mutations
 * 
 * Commands:
 * - doctor: run diagnostics (DB integrity, schema version, etc.)
 * - channel list: list all channels
 * - topic list: list topics in a channel
 * - msg tail: get latest messages from a topic
 * - msg page: paginate messages with cursor
 * - attachment list: list topic attachments
 * - search: full-text search (if FTS available)
 * - listen: stream events via WebSocket
 */

// Runtime guard: require Bun
if (typeof Bun === "undefined") {
  console.error("Error: @agentlip/cli requires Bun runtime (https://bun.sh)");
  process.exit(1);
}

import { openWorkspaceDbReadonly, isQueryOnly, WorkspaceNotFoundError, DatabaseNotFoundError, discoverWorkspaceRoot } from "./index.js";
import {
  listChannels,
  getChannelByName,
  listTopicsByChannel,
  tailMessages,
  listMessages,
  listTopicAttachments,
  isFtsAvailable,
  type Channel,
  type Topic,
  type Message,
  type TopicAttachment,
  type ListResult,
} from "@agentlip/kernel";
import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface GlobalOptions {
  workspace?: string;
  json?: boolean;
}

interface DoctorResult {
  status: "ok" | "error";
  workspace_root?: string;
  db_path?: string;
  db_id?: string;
  schema_version?: number;
  query_only?: boolean;
  error?: string;
}

interface ChannelListResult {
  status: "ok" | "error";
  channels?: Channel[];
  count?: number;
  error?: string;
}

interface TopicListResult {
  status: "ok" | "error";
  topics?: Topic[];
  count?: number;
  hasMore?: boolean;
  error?: string;
}

interface MessageListResult {
  status: "ok" | "error";
  messages?: Message[];
  count?: number;
  hasMore?: boolean;
  error?: string;
}

interface AttachmentListResult {
  status: "ok" | "error";
  attachments?: TopicAttachment[];
  count?: number;
  error?: string;
}

interface SearchResult {
  status: "ok" | "error";
  messages?: Message[];
  count?: number;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Listen Types (WS streaming)
// ─────────────────────────────────────────────────────────────────────────────

interface ListenOptions extends GlobalOptions {
  since: number;
  channels: string[];
  topicIds: string[];
}

interface ServerJsonData {
  host: string;
  port: number;
  auth_token: string;
}

interface HelloMessage {
  type: "hello";
  after_event_id: number;
  subscriptions?: {
    channels?: string[];
    topics?: string[];
  };
}

interface HelloOkMessage {
  type: "hello_ok";
  replay_until: number;
  instance_id: string;
}

interface EventEnvelope {
  type: "event";
  event_id: number;
  ts: string;
  name: string;
  scope: {
    channel_id?: string | null;
    topic_id?: string | null;
    topic_id2?: string | null;
  };
  data: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse arguments and extract global options
 */
function parseGlobalOptions(args: string[]): { globalOpts: GlobalOptions; remainingArgs: string[] } {
  const globalOpts: GlobalOptions = {};
  const remainingArgs: string[] = [];
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--workspace" || arg === "-w") {
      const value = args[++i];
      if (!value) {
        throw new Error("--workspace requires a value");
      }
      globalOpts.workspace = value;
    } else if (arg === "--json") {
      globalOpts.json = true;
    } else {
      remainingArgs.push(arg);
    }
  }
  
  return { globalOpts, remainingArgs };
}

/**
 * Open workspace DB with standardized error handling
 */
async function withWorkspaceDb<T>(
  workspace: string | undefined,
  fn: (db: Database) => T
): Promise<T> {
  const { db } = await openWorkspaceDbReadonly({ workspace });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Output result as JSON or human-readable format
 */
function output(result: object, json: boolean, humanFormatter: () => void): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    humanFormatter();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// doctor command
// ─────────────────────────────────────────────────────────────────────────────

async function runDoctor(options: GlobalOptions): Promise<DoctorResult> {
  try {
    const { db, workspaceRoot, dbPath } = await openWorkspaceDbReadonly({
      workspace: options.workspace,
    });

    try {
      const queryOnly = isQueryOnly(db);
      let dbId: string | undefined;
      let schemaVersion: number | undefined;

      try {
        const metaRow = db
          .query<{ key: string; value: string }, []>("SELECT key, value FROM meta WHERE key IN ('db_id', 'schema_version')")
          .all();

        for (const row of metaRow) {
          if (row.key === "db_id") dbId = row.value;
          if (row.key === "schema_version") schemaVersion = parseInt(row.value, 10);
        }
      } catch {
        // meta table may not exist yet
      }

      return {
        status: "ok",
        workspace_root: workspaceRoot,
        db_path: dbPath,
        db_id: dbId,
        schema_version: schemaVersion,
        query_only: queryOnly,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError || err instanceof DatabaseNotFoundError) {
      return { status: "error", error: err.message };
    }
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function printHumanDoctor(result: DoctorResult): void {
  if (result.status === "ok") {
    console.log("✓ Workspace found");
    console.log(`  Workspace Root:  ${result.workspace_root}`);
    console.log(`  Database Path:   ${result.db_path}`);
    console.log(`  Database ID:     ${result.db_id ?? "(not initialized)"}`);
    console.log(`  Schema Version:  ${result.schema_version ?? "(not initialized)"}`);
    console.log(`  Query Only:      ${result.query_only ? "yes" : "no"}`);
  } else {
    console.log("✗ Workspace check failed");
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// channel list command
// ─────────────────────────────────────────────────────────────────────────────

async function runChannelList(options: GlobalOptions): Promise<ChannelListResult> {
  try {
    return await withWorkspaceDb(options.workspace, (db) => {
      const channels = listChannels(db);
      return {
        status: "ok",
        channels,
        count: channels.length,
      };
    });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError || err instanceof DatabaseNotFoundError) {
      return { status: "error", error: err.message };
    }
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function printHumanChannelList(result: ChannelListResult): void {
  if (result.status === "ok") {
    if (result.channels && result.channels.length > 0) {
      console.log(`Channels (${result.count}):`);
      for (const ch of result.channels) {
        const desc = ch.description ? ` - ${ch.description}` : "";
        console.log(`  ${ch.id}  ${ch.name}${desc}`);
      }
    } else {
      console.log("No channels found.");
    }
  } else {
    console.error(`Error: ${result.error}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// topic list command
// ─────────────────────────────────────────────────────────────────────────────

interface TopicListOptions extends GlobalOptions {
  channelId: string;
  limit?: number;
  offset?: number;
}

async function runTopicList(options: TopicListOptions): Promise<TopicListResult> {
  try {
    return await withWorkspaceDb(options.workspace, (db) => {
      const result = listTopicsByChannel(db, options.channelId, {
        limit: options.limit,
        offset: options.offset,
      });
      return {
        status: "ok",
        topics: result.items,
        count: result.items.length,
        hasMore: result.hasMore,
      };
    });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError || err instanceof DatabaseNotFoundError) {
      return { status: "error", error: err.message };
    }
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function printHumanTopicList(result: TopicListResult): void {
  if (result.status === "ok") {
    if (result.topics && result.topics.length > 0) {
      console.log(`Topics (${result.count}${result.hasMore ? "+": ""}):`);
      for (const t of result.topics) {
        console.log(`  ${t.id}  ${t.title}`);
        console.log(`    updated: ${t.updated_at}`);
      }
      if (result.hasMore) {
        console.log("  (more topics available, use --offset to paginate)");
      }
    } else {
      console.log("No topics found.");
    }
  } else {
    console.error(`Error: ${result.error}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// msg tail command
// ─────────────────────────────────────────────────────────────────────────────

interface MsgTailOptions extends GlobalOptions {
  topicId: string;
  limit?: number;
}

async function runMsgTail(options: MsgTailOptions): Promise<MessageListResult> {
  try {
    return await withWorkspaceDb(options.workspace, (db) => {
      const messages = tailMessages(db, options.topicId, options.limit ?? 50);
      return {
        status: "ok",
        messages,
        count: messages.length,
      };
    });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError || err instanceof DatabaseNotFoundError) {
      return { status: "error", error: err.message };
    }
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function printHumanMsgList(result: MessageListResult): void {
  if (result.status === "ok") {
    if (result.messages && result.messages.length > 0) {
      console.log(`Messages (${result.count}${result.hasMore ? "+": ""}):`);
      for (const m of result.messages) {
        const deleted = m.deleted_at ? " [DELETED]" : "";
        const edited = m.edited_at ? " [edited]" : "";
        console.log(`  [${m.id}] ${m.sender}${deleted}${edited}`);
        console.log(`    ${m.created_at}`);
        if (!m.deleted_at) {
          // Truncate long content
          const content = m.content_raw.length > 200 
            ? m.content_raw.slice(0, 200) + "..."
            : m.content_raw;
          console.log(`    ${content}`);
        }
        console.log();
      }
      if (result.hasMore) {
        console.log("  (more messages available)");
      }
    } else {
      console.log("No messages found.");
    }
  } else {
    console.error(`Error: ${result.error}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// msg page command
// ─────────────────────────────────────────────────────────────────────────────

interface MsgPageOptions extends GlobalOptions {
  topicId: string;
  beforeId?: string;
  afterId?: string;
  limit?: number;
}

async function runMsgPage(options: MsgPageOptions): Promise<MessageListResult> {
  try {
    return await withWorkspaceDb(options.workspace, (db) => {
      const result = listMessages(db, {
        topicId: options.topicId,
        beforeId: options.beforeId,
        afterId: options.afterId,
        limit: options.limit ?? 50,
      });
      return {
        status: "ok",
        messages: result.items,
        count: result.items.length,
        hasMore: result.hasMore,
      };
    });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError || err instanceof DatabaseNotFoundError) {
      return { status: "error", error: err.message };
    }
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// attachment list command
// ─────────────────────────────────────────────────────────────────────────────

interface AttachmentListOptions extends GlobalOptions {
  topicId: string;
  kind?: string;
}

async function runAttachmentList(options: AttachmentListOptions): Promise<AttachmentListResult> {
  try {
    return await withWorkspaceDb(options.workspace, (db) => {
      const attachments = listTopicAttachments(db, options.topicId, options.kind);
      return {
        status: "ok",
        attachments,
        count: attachments.length,
      };
    });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError || err instanceof DatabaseNotFoundError) {
      return { status: "error", error: err.message };
    }
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function printHumanAttachmentList(result: AttachmentListResult): void {
  if (result.status === "ok") {
    if (result.attachments && result.attachments.length > 0) {
      console.log(`Attachments (${result.count}):`);
      for (const a of result.attachments) {
        console.log(`  [${a.id}] ${a.kind}${a.key ? `:${a.key}` : ""}`);
        console.log(`    created: ${a.created_at}`);
        console.log(`    value: ${JSON.stringify(a.value_json)}`);
        console.log();
      }
    } else {
      console.log("No attachments found.");
    }
  } else {
    console.error(`Error: ${result.error}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// search command
// ─────────────────────────────────────────────────────────────────────────────

interface SearchOptions extends GlobalOptions {
  query: string;
  limit?: number;
}

async function runSearch(options: SearchOptions): Promise<SearchResult> {
  try {
    return await withWorkspaceDb(options.workspace, (db) => {
      // Check if FTS is available
      if (!isFtsAvailable(db)) {
        return {
          status: "error",
          error: "Full-text search not available: messages_fts table does not exist. Enable FTS by running migrations with enableFts=true.",
        };
      }

      const limit = options.limit ?? 50;
      // Use FTS5 MATCH syntax
      const rows = db.query<Message, [string, number]>(`
        SELECT m.id, m.topic_id, m.channel_id, m.sender, m.content_raw, m.version,
               m.created_at, m.edited_at, m.deleted_at, m.deleted_by
        FROM messages m
        JOIN messages_fts fts ON m.rowid = fts.rowid
        WHERE messages_fts MATCH ?
        ORDER BY m.created_at DESC
        LIMIT ?
      `).all(options.query, limit);

      return {
        status: "ok",
        messages: rows,
        count: rows.length,
      };
    });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError || err instanceof DatabaseNotFoundError) {
      return { status: "error", error: err.message };
    }
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function printHumanSearch(result: SearchResult): void {
  if (result.status === "ok") {
    if (result.messages && result.messages.length > 0) {
      console.log(`Search results (${result.count}):`);
      for (const m of result.messages) {
        const deleted = m.deleted_at ? " [DELETED]" : "";
        console.log(`  [${m.id}] ${m.sender} in topic:${m.topic_id}${deleted}`);
        console.log(`    ${m.created_at}`);
        if (!m.deleted_at) {
          const content = m.content_raw.length > 200 
            ? m.content_raw.slice(0, 200) + "..."
            : m.content_raw;
          console.log(`    ${content}`);
        }
        console.log();
      }
    } else {
      console.log("No results found.");
    }
  } else {
    console.error(`Error: ${result.error}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// msg send command (HTTP mutation)
// ─────────────────────────────────────────────────────────────────────────────

interface MsgSendOptions extends GlobalOptions {
  topicId: string;
  sender: string;
  content?: string;
  stdin?: boolean;
}

interface MsgSendResult {
  status: "ok" | "error";
  message_id?: string;
  event_id?: number;
  error?: string;
  code?: string;
}

async function runMsgSend(options: MsgSendOptions): Promise<MsgSendResult> {
  try {
    // Get content from stdin or --content
    let content: string;
    if (options.stdin) {
      // Read from stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      content = Buffer.concat(chunks).toString("utf-8");
    } else if (options.content !== undefined) {
      content = options.content;
    } else {
      return {
        status: "error",
        error: "Either --content or --stdin is required",
        code: "INVALID_INPUT",
      };
    }

    // Get hub context
    const ctx = await getHubContext(options.workspace);
    if (!ctx) {
      return {
        status: "error",
        error: "Hub not running (server.json not found)",
        code: "HUB_NOT_RUNNING",
      };
    }

    // Make request
    const result = await hubRequest<{ message: any; event_id: number }>(
      ctx,
      "POST",
      "/api/v1/messages",
      {
        topic_id: options.topicId,
        sender: options.sender,
        content_raw: content,
      }
    );

    if (!result.ok) {
      return {
        status: "error",
        error: result.error,
        code: result.code,
      };
    }

    return {
      status: "ok",
      message_id: result.data.message.id,
      event_id: result.data.event_id,
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      code: "INTERNAL_ERROR",
    };
  }
}

function printHumanMsgSend(result: MsgSendResult): void {
  if (result.status === "ok") {
    console.log(`Message sent: ${result.message_id}`);
    if (result.event_id) {
      console.log(`Event ID: ${result.event_id}`);
    }
  } else {
    console.error(`Error: ${result.error}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// msg edit command (HTTP mutation)
// ─────────────────────────────────────────────────────────────────────────────

interface MsgEditOptions extends GlobalOptions {
  messageId: string;
  content: string;
  expectedVersion?: number;
}

interface MsgEditResult {
  status: "ok" | "error";
  message?: any;
  event_id?: number;
  error?: string;
  code?: string;
  details?: Record<string, unknown>;
}

async function runMsgEdit(options: MsgEditOptions): Promise<MsgEditResult> {
  try {
    const ctx = await getHubContext(options.workspace);
    if (!ctx) {
      return {
        status: "error",
        error: "Hub not running (server.json not found)",
        code: "HUB_NOT_RUNNING",
      };
    }

    const result = await hubRequest<{ message: any; event_id: number }>(
      ctx,
      "PATCH",
      `/api/v1/messages/${options.messageId}`,
      {
        op: "edit",
        content_raw: options.content,
        expected_version: options.expectedVersion,
      }
    );

    if (!result.ok) {
      return {
        status: "error",
        error: result.error,
        code: result.code,
        details: result.details,
      };
    }

    return {
      status: "ok",
      message: result.data.message,
      event_id: result.data.event_id,
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      code: "INTERNAL_ERROR",
    };
  }
}

function printHumanMsgEdit(result: MsgEditResult): void {
  if (result.status === "ok") {
    console.log(`Message edited: ${result.message?.id}`);
    if (result.event_id) {
      console.log(`Event ID: ${result.event_id}`);
    }
  } else {
    console.error(`Error: ${result.error}`);
    if (result.code === "VERSION_CONFLICT" && result.details?.current) {
      console.error(`  Current version: ${result.details.current}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// msg delete command (HTTP mutation)
// ─────────────────────────────────────────────────────────────────────────────

interface MsgDeleteOptions extends GlobalOptions {
  messageId: string;
  actor: string;
  expectedVersion?: number;
}

interface MsgDeleteResult {
  status: "ok" | "error";
  deleted?: boolean;
  event_id?: number | null;
  error?: string;
  code?: string;
  details?: Record<string, unknown>;
}

async function runMsgDelete(options: MsgDeleteOptions): Promise<MsgDeleteResult> {
  try {
    const ctx = await getHubContext(options.workspace);
    if (!ctx) {
      return {
        status: "error",
        error: "Hub not running (server.json not found)",
        code: "HUB_NOT_RUNNING",
      };
    }

    const result = await hubRequest<{ message: any; event_id: number | null }>(
      ctx,
      "PATCH",
      `/api/v1/messages/${options.messageId}`,
      {
        op: "delete",
        actor: options.actor,
        expected_version: options.expectedVersion,
      }
    );

    if (!result.ok) {
      return {
        status: "error",
        error: result.error,
        code: result.code,
        details: result.details,
      };
    }

    return {
      status: "ok",
      deleted: true,
      event_id: result.data.event_id,
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      code: "INTERNAL_ERROR",
    };
  }
}

function printHumanMsgDelete(result: MsgDeleteResult): void {
  if (result.status === "ok") {
    console.log("Message deleted");
    if (result.event_id !== null && result.event_id !== undefined) {
      console.log(`Event ID: ${result.event_id}`);
    }
  } else {
    console.error(`Error: ${result.error}`);
    if (result.code === "VERSION_CONFLICT" && result.details?.current) {
      console.error(`  Current version: ${result.details.current}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// msg retopic command (HTTP mutation)
// ─────────────────────────────────────────────────────────────────────────────

interface MsgRetopicOptions extends GlobalOptions {
  messageId: string;
  toTopicId: string;
  mode: "one" | "later" | "all";
  force?: boolean;
  expectedVersion?: number;
}

interface MsgRetopicResult {
  status: "ok" | "error";
  affected_count?: number;
  event_ids?: number[];
  error?: string;
  code?: string;
  details?: Record<string, unknown>;
}

async function runMsgRetopic(options: MsgRetopicOptions): Promise<MsgRetopicResult> {
  try {
    // Safety check: mode=all requires --force
    if (options.mode === "all" && !options.force) {
      return {
        status: "error",
        error: "Mode 'all' requires --force flag",
        code: "INVALID_INPUT",
      };
    }

    const ctx = await getHubContext(options.workspace);
    if (!ctx) {
      return {
        status: "error",
        error: "Hub not running (server.json not found)",
        code: "HUB_NOT_RUNNING",
      };
    }

    const result = await hubRequest<{ affected_count: number; event_ids: number[] }>(
      ctx,
      "PATCH",
      `/api/v1/messages/${options.messageId}`,
      {
        op: "move_topic",
        to_topic_id: options.toTopicId,
        mode: options.mode,
        expected_version: options.expectedVersion,
      }
    );

    if (!result.ok) {
      return {
        status: "error",
        error: result.error,
        code: result.code,
        details: result.details,
      };
    }

    return {
      status: "ok",
      affected_count: result.data.affected_count,
      event_ids: result.data.event_ids,
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      code: "INTERNAL_ERROR",
    };
  }
}

function printHumanMsgRetopic(result: MsgRetopicResult): void {
  if (result.status === "ok") {
    console.log(`Moved ${result.affected_count} message(s)`);
    if (result.event_ids && result.event_ids.length > 0) {
      console.log(`Event IDs: ${result.event_ids.join(", ")}`);
    }
  } else {
    console.error(`Error: ${result.error}`);
    if (result.code === "CROSS_CHANNEL_MOVE") {
      console.error("  Cross-channel moves are not allowed");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// topic rename command (HTTP mutation)
// ─────────────────────────────────────────────────────────────────────────────

interface TopicRenameOptions extends GlobalOptions {
  topicId: string;
  title: string;
}

interface TopicRenameResult {
  status: "ok" | "error";
  topic?: any;
  event_id?: number;
  error?: string;
  code?: string;
}

async function runTopicRename(options: TopicRenameOptions): Promise<TopicRenameResult> {
  try {
    const ctx = await getHubContext(options.workspace);
    if (!ctx) {
      return {
        status: "error",
        error: "Hub not running (server.json not found)",
        code: "HUB_NOT_RUNNING",
      };
    }

    const result = await hubRequest<{ topic: any; event_id: number }>(
      ctx,
      "PATCH",
      `/api/v1/topics/${options.topicId}`,
      {
        title: options.title,
      }
    );

    if (!result.ok) {
      return {
        status: "error",
        error: result.error,
        code: result.code,
      };
    }

    return {
      status: "ok",
      topic: result.data.topic,
      event_id: result.data.event_id,
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      code: "INTERNAL_ERROR",
    };
  }
}

function printHumanTopicRename(result: TopicRenameResult): void {
  if (result.status === "ok") {
    console.log(`Topic renamed: ${result.topic?.id}`);
    console.log(`New title: ${result.topic?.title}`);
    if (result.event_id) {
      console.log(`Event ID: ${result.event_id}`);
    }
  } else {
    console.error(`Error: ${result.error}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// attachment add command (HTTP mutation)
// ─────────────────────────────────────────────────────────────────────────────

interface AttachmentAddOptions extends GlobalOptions {
  topicId: string;
  kind: string;
  valueJson: string;
  key?: string;
  sourceMessageId?: string;
  dedupeKey?: string;
}

interface AttachmentAddResult {
  status: "ok" | "error";
  attachment?: any;
  event_id?: number | null;
  deduplicated?: boolean;
  error?: string;
  code?: string;
}

async function runAttachmentAdd(options: AttachmentAddOptions): Promise<AttachmentAddResult> {
  try {
    // Parse value_json
    let valueJson: Record<string, unknown>;
    try {
      valueJson = JSON.parse(options.valueJson);
      if (typeof valueJson !== "object" || Array.isArray(valueJson)) {
        return {
          status: "error",
          error: "value_json must be a JSON object",
          code: "INVALID_INPUT",
        };
      }
    } catch {
      return {
        status: "error",
        error: "value_json is not valid JSON",
        code: "INVALID_INPUT",
      };
    }

    const ctx = await getHubContext(options.workspace);
    if (!ctx) {
      return {
        status: "error",
        error: "Hub not running (server.json not found)",
        code: "HUB_NOT_RUNNING",
      };
    }

    const body: Record<string, unknown> = {
      kind: options.kind,
      value_json: valueJson,
    };
    if (options.key) body.key = options.key;
    if (options.sourceMessageId) body.source_message_id = options.sourceMessageId;
    if (options.dedupeKey) body.dedupe_key = options.dedupeKey;

    const result = await hubRequest<{ attachment: any; event_id: number | null }>(
      ctx,
      "POST",
      `/api/v1/topics/${options.topicId}/attachments`,
      body
    );

    if (!result.ok) {
      return {
        status: "error",
        error: result.error,
        code: result.code,
      };
    }

    return {
      status: "ok",
      attachment: result.data.attachment,
      event_id: result.data.event_id,
      deduplicated: result.data.event_id === null,
    };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      code: "INTERNAL_ERROR",
    };
  }
}

function printHumanAttachmentAdd(result: AttachmentAddResult): void {
  if (result.status === "ok") {
    if (result.deduplicated) {
      console.log(`Attachment already exists: ${result.attachment?.id}`);
      console.log("(deduplicated, no new event)");
    } else {
      console.log(`Attachment added: ${result.attachment?.id}`);
      if (result.event_id) {
        console.log(`Event ID: ${result.event_id}`);
      }
    }
  } else {
    console.error(`Error: ${result.error}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// listen command (WebSocket event stream)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read server.json from workspace .agentlip directory.
 */
async function readServerJson(workspaceRoot: string): Promise<ServerJsonData | null> {
  try {
    const serverJsonPath = join(workspaceRoot, ".agentlip", "server.json");
    const content = await readFile(serverJsonPath, "utf-8");
    return JSON.parse(content) as ServerJsonData;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP API helpers (for mutations)
// ─────────────────────────────────────────────────────────────────────────────

interface HubContext {
  baseUrl: string;
  authToken: string;
}

/**
 * Get hub context (baseUrl + authToken) by reading server.json.
 * Returns null if hub is not running.
 */
async function getHubContext(workspace?: string): Promise<HubContext | null> {
  const startPath = workspace ?? process.cwd();
  const discovered = await discoverWorkspaceRoot(startPath);
  if (!discovered) {
    return null;
  }

  const serverJson = await readServerJson(discovered.root);
  if (!serverJson) {
    return null;
  }

  const baseUrl = `http://${serverJson.host}:${serverJson.port}`;
  return {
    baseUrl,
    authToken: serverJson.auth_token,
  };
}

/**
 * Make authenticated HTTP request to hub.
 * Returns parsed JSON response.
 */
async function hubRequest<T = unknown>(
  ctx: HubContext,
  method: string,
  path: string,
  body?: unknown
): Promise<{ ok: true; data: T; status: number } | { ok: false; error: string; code: string; status: number; details?: Record<string, unknown> }> {
  try {
    const url = `${ctx.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${ctx.authToken}`,
    };

    let requestInit: RequestInit = { method, headers };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestInit.body = JSON.stringify(body);
    }

    const response = await fetch(url, requestInit);
    const text = await response.text();

    // Try to parse as JSON
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // Not JSON - treat as plain error
      return {
        ok: false,
        error: text || "Unknown error",
        code: "INTERNAL_ERROR",
        status: response.status,
      };
    }

    if (response.ok) {
      return { ok: true, data: json as T, status: response.status };
    }

    // Error response - extract error/code/details
    const errorMsg = json.error || json.message || "Unknown error";
    const errorCode = json.code || "INTERNAL_ERROR";
    const details = json.details;

    return {
      ok: false,
      error: errorMsg,
      code: errorCode,
      status: response.status,
      details,
    };
  } catch (err) {
    // Network error
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: "CONNECTION_FAILED",
      status: 0,
    };
  }
}

/**
 * Handle error response and exit with appropriate code.
 */
function handleMutationError(error: {
  error: string;
  code: string;
  status: number;
  details?: Record<string, unknown>;
}, json: boolean): never {
  if (json) {
    // Output as JSON error
    console.log(JSON.stringify({
      status: "error",
      error: error.error,
      code: error.code,
      details: error.details,
    }));
  } else {
    // Human-readable error to stderr
    console.error(`Error: ${error.error}`);
    if (error.code === "VERSION_CONFLICT" && error.details?.current) {
      console.error(`  Current version: ${error.details.current}`);
    }
  }

  // Exit with appropriate code per plan
  if (error.code === "VERSION_CONFLICT") {
    process.exit(2); // Conflict
  } else if (error.code === "CONNECTION_FAILED" || error.code === "HUB_NOT_RUNNING") {
    process.exit(3); // Hub not running
  } else if (error.code === "UNAUTHORIZED") {
    process.exit(4); // Auth failed
  } else {
    process.exit(1); // General error
  }
}

/**
 * Map channel names to IDs using local DB.
 * If a value looks like a channel name (exists in DB), map to ID; otherwise treat as ID.
 */
async function resolveChannelIds(
  workspaceRoot: string,
  channelInputs: string[]
): Promise<string[]> {
  if (channelInputs.length === 0) return [];

  const { db } = await openWorkspaceDbReadonly({ workspace: workspaceRoot });
  try {
    const resolved: string[] = [];
    for (const input of channelInputs) {
      // Try to find by name first
      const byName = getChannelByName(db, input);
      if (byName) {
        resolved.push(byName.id);
      } else {
        // Treat as ID
        resolved.push(input);
      }
    }
    return resolved;
  } finally {
    db.close();
  }
}

/**
 * Run the listen command - connects to hub WS and streams events as JSONL.
 */
async function runListen(options: ListenOptions): Promise<void> {
  // 1. Discover workspace root
  const startPath = options.workspace ?? process.cwd();
  const discovered = await discoverWorkspaceRoot(startPath);
  if (!discovered) {
    console.error(`Error: No workspace found (no .agentlip/db.sqlite3 in directory tree starting from ${startPath})`);
    process.exit(1);
  }
  const workspaceRoot = discovered.root;

  // 2. Read server.json
  const serverJson = await readServerJson(workspaceRoot);
  if (!serverJson) {
    console.error("Error: Hub not running (server.json not found). Start hub with: agentlipd up");
    process.exit(3);
  }

  // 3. Map channel names to IDs
  let channelIds: string[] = [];
  if (options.channels.length > 0) {
    try {
      channelIds = await resolveChannelIds(workspaceRoot, options.channels);
    } catch (err) {
      console.error(`Error resolving channels: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  const topicIds = options.topicIds;

  // 4. Build WS URL
  const wsUrl = `ws://${serverJson.host}:${serverJson.port}/ws?token=${encodeURIComponent(serverJson.auth_token)}`;

  // 5. Connection state
  let lastSeenEventId = options.since;
  const seenEventIds = new Set<number>();
  let reconnectDelay = 1000;
  const maxReconnectDelay = 30000;
  let shouldRun = true;
  let currentWs: WebSocket | null = null;

  // Handle Ctrl+C
  const cleanup = () => {
    shouldRun = false;
    if (currentWs) {
      try {
        currentWs.close(1000, "Client shutdown");
      } catch {
        // Ignore close errors
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // 6. Connection loop
  while (shouldRun) {
    try {
      await connectAndStream(
        wsUrl,
        lastSeenEventId,
        channelIds,
        topicIds,
        seenEventIds,
        (eventId) => { lastSeenEventId = eventId; },
        () => shouldRun,
        (ws) => { currentWs = ws; }
      );

      // If we reach here, connection closed cleanly (code 1000)
      // Check if we should reconnect
      if (!shouldRun) break;

    } catch (err) {
      if (!shouldRun) break;

      const errorMsg = err instanceof Error ? err.message : String(err);

      // Check for auth failure (don't retry)
      if (errorMsg.includes("4401") || errorMsg.includes("Unauthorized")) {
        console.error("Error: Authentication failed. Check hub auth token.");
        process.exit(4);
      }

      // Log reconnection attempt
      console.error(`Connection error: ${errorMsg}. Reconnecting in ${reconnectDelay / 1000}s...`);

      // Wait before reconnecting
      await sleep(reconnectDelay);

      // Exponential backoff
      reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
    }

    // Reset reconnect delay on successful connection cycle
    reconnectDelay = 1000;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Connect to WebSocket and stream events until disconnect.
 */
async function connectAndStream(
  wsUrl: string,
  afterEventId: number,
  channelIds: string[],
  topicIds: string[],
  seenEventIds: Set<number>,
  updateLastSeen: (eventId: number) => void,
  shouldContinue: () => boolean,
  setCurrentWs: (ws: WebSocket | null) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    setCurrentWs(ws);

    let handshakeComplete = false;
    let resolved = false;

    const finish = (error?: Error) => {
      if (resolved) return;
      resolved = true;
      setCurrentWs(null);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const openTimeout = setTimeout(() => {
      if (!resolved) {
        ws.close();
        finish(new Error("WebSocket open timeout after 10s"));
      }
    }, 10000);

    ws.onopen = () => {
      clearTimeout(openTimeout);

      // Build hello message
      const hello: HelloMessage = {
        type: "hello",
        after_event_id: afterEventId,
      };

      // Only add subscriptions if filters are specified
      // Per plan: omit subscriptions field entirely for ALL events
      if (channelIds.length > 0 || topicIds.length > 0) {
        hello.subscriptions = {};
        if (channelIds.length > 0) {
          hello.subscriptions.channels = channelIds;
        }
        if (topicIds.length > 0) {
          hello.subscriptions.topics = topicIds;
        }
      }

      ws.send(JSON.stringify(hello));
    };

    ws.onmessage = (event) => {
      if (!shouldContinue()) {
        ws.close(1000, "Client shutdown");
        return;
      }

      try {
        const data = JSON.parse(String(event.data));

        if (data.type === "hello_ok") {
          handshakeComplete = true;
          // Log hello_ok to stderr for debugging (not stdout which is for JSONL)
          // console.error(`Connected. replay_until=${(data as HelloOkMessage).replay_until}`);
          return;
        }

        if (data.type === "event") {
          const envelope = data as EventEnvelope;

          // Deduplicate
          if (seenEventIds.has(envelope.event_id)) {
            return;
          }
          seenEventIds.add(envelope.event_id);

          // Track for resume
          updateLastSeen(envelope.event_id);

          // Output as JSONL to stdout
          console.log(JSON.stringify(envelope));
        }
      } catch (err) {
        // Log parse errors to stderr
        console.error(`Error parsing message: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    ws.onerror = (err) => {
      clearTimeout(openTimeout);
      if (!handshakeComplete) {
        finish(new Error(`WebSocket error: ${String(err)}`));
      }
    };

    ws.onclose = (event) => {
      clearTimeout(openTimeout);

      const code = (event as CloseEvent).code;
      const reason = (event as CloseEvent).reason || "unknown";

      // Check close codes per plan:
      // 1000: Normal closure - don't reconnect
      // 1001: Going away (server shutdown) - reconnect after delay
      // 1008: Policy violation (backpressure) - reconnect immediately  
      // 1011: Internal error - reconnect with backoff
      // 4401: Unauthorized - don't reconnect

      if (code === 1000) {
        // Normal close - don't reconnect
        finish();
        return;
      }

      if (code === 4401) {
        finish(new Error("4401: Unauthorized"));
        return;
      }

      // All other codes: trigger reconnect via error
      finish(new Error(`WebSocket closed: code=${code}, reason=${reason}`));
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Help messages
// ─────────────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log("Usage: agentlip <command> [options]");
  console.log();
  console.log("Commands:");
  console.log("  doctor               Run diagnostics on workspace DB");
  console.log("  channel list         List all channels");
  console.log("  topic list           List topics in a channel");
  console.log("  msg tail             Get latest messages from a topic");
  console.log("  msg page             Paginate messages with cursor");
  console.log("  attachment list      List topic attachments");
  console.log("  search               Full-text search messages");
  console.log("  listen               Stream events via WebSocket");
  console.log();
  console.log("Global options:");
  console.log("  --workspace <path>   Explicit workspace root (default: auto-discover)");
  console.log("  --json               Output as JSON");
  console.log("  --help, -h           Show this help");
  console.log();
  console.log("Use '<command> --help' for more information on a command.");
}

function printDoctorHelp(): void {
  console.log("Usage: agentlip doctor [--workspace <path>] [--json]");
  console.log();
  console.log("Run diagnostics on workspace database.");
  console.log();
  console.log("Options:");
  console.log("  --workspace <path>  Explicit workspace root (default: auto-discover)");
  console.log("  --json              Output as JSON");
  console.log("  --help, -h          Show this help");
  console.log();
  console.log("Exit codes:");
  console.log("  0  OK");
  console.log("  1  Error (workspace not found, DB issues, etc.)");
}

function printChannelHelp(): void {
  console.log("Usage: agentlip channel <subcommand> [options]");
  console.log();
  console.log("Subcommands:");
  console.log("  list    List all channels");
  console.log();
  console.log("Options:");
  console.log("  --workspace <path>  Explicit workspace root (default: auto-discover)");
  console.log("  --json              Output as JSON");
  console.log("  --help, -h          Show this help");
}

function printTopicHelp(): void {
  console.log("Usage: agentlip topic <subcommand> [options]");
  console.log();
  console.log("Subcommands (read-only):");
  console.log("  list      List topics in a channel");
  console.log();
  console.log("Subcommands (mutations, require running hub):");
  console.log("  rename    Rename a topic");
  console.log();
  console.log("Usage:");
  console.log("  agentlip topic list --channel-id <id> [--limit N] [--offset N]");
  console.log("  agentlip topic rename <topic_id> --title <new_title>");
  console.log();
  console.log("Options:");
  console.log("  --channel-id <id>   Channel ID (required for list)");
  console.log("  --title <title>     New topic title (required for rename)");
  console.log("  --limit <n>         Max topics to return (default: 50)");
  console.log("  --offset <n>        Offset for pagination (default: 0)");
  console.log("  --workspace <path>  Explicit workspace root");
  console.log("  --json              Output as JSON");
  console.log("  --help, -h          Show this help");
}

function printMsgHelp(): void {
  console.log("Usage: agentlip msg <subcommand> [options]");
  console.log();
  console.log("Subcommands (read-only):");
  console.log("  tail      Get latest messages from a topic");
  console.log("  page      Paginate messages with cursor");
  console.log();
  console.log("Subcommands (mutations, require running hub):");
  console.log("  send      Send a message");
  console.log("  edit      Edit a message");
  console.log("  delete    Delete a message (tombstone)");
  console.log("  retopic   Move message(s) to different topic");
  console.log();
  console.log("Read-only usage:");
  console.log("  agentlip msg tail --topic-id <id> [--limit N]");
  console.log("  agentlip msg page --topic-id <id> [--before-id <id>] [--after-id <id>] [--limit N]");
  console.log();
  console.log("Mutation usage:");
  console.log("  agentlip msg send --topic-id <id> --sender <name> [--content <text>] [--stdin]");
  console.log("  agentlip msg edit <message_id> --content <text> [--expected-version <n>]");
  console.log("  agentlip msg delete <message_id> --actor <name> [--expected-version <n>]");
  console.log("  agentlip msg retopic <message_id> --to-topic-id <id> --mode <one|later|all> [--force]");
  console.log();
  console.log("Options:");
  console.log("  --topic-id <id>       Topic ID (required for tail/page/send)");
  console.log("  --sender <name>       Sender name (required for send)");
  console.log("  --content <text>      Message content (send/edit)");
  console.log("  --stdin               Read content from stdin (send only)");
  console.log("  --actor <name>        Actor performing delete (required for delete)");
  console.log("  --expected-version <n> Expected version for optimistic locking");
  console.log("  --to-topic-id <id>    Target topic for retopic");
  console.log("  --mode <mode>         Retopic mode: one, later, or all");
  console.log("  --force               Required for retopic mode=all");
  console.log("  --before-id <id>      Get messages before this ID (page command)");
  console.log("  --after-id <id>       Get messages after this ID (page command)");
  console.log("  --limit <n>           Max messages to return (default: 50)");
  console.log("  --workspace <path>    Explicit workspace root");
  console.log("  --json                Output as JSON");
  console.log("  --help, -h            Show this help");
  console.log();
  console.log("Exit codes:");
  console.log("  0  Success");
  console.log("  1  General error");
  console.log("  2  Version conflict (optimistic lock failed)");
  console.log("  3  Hub not running");
  console.log("  4  Authentication failed");
}

function printAttachmentHelp(): void {
  console.log("Usage: agentlip attachment <subcommand> [options]");
  console.log();
  console.log("Subcommands (read-only):");
  console.log("  list    List attachments for a topic");
  console.log();
  console.log("Subcommands (mutations, require running hub):");
  console.log("  add     Add an attachment to a topic");
  console.log();
  console.log("Usage:");
  console.log("  agentlip attachment list --topic-id <id> [--kind <kind>]");
  console.log("  agentlip attachment add --topic-id <id> --kind <kind> --value-json <json>");
  console.log("      [--key <key>] [--source-message-id <id>] [--dedupe-key <key>]");
  console.log();
  console.log("Options:");
  console.log("  --topic-id <id>           Topic ID (required)");
  console.log("  --kind <kind>             Attachment kind (required for add, filter for list)");
  console.log("  --value-json <json>       JSON value (required for add)");
  console.log("  --key <key>               Optional key for namespacing");
  console.log("  --source-message-id <id>  Source message ID");
  console.log("  --dedupe-key <key>        Custom deduplication key");
  console.log("  --workspace <path>        Explicit workspace root");
  console.log("  --json                    Output as JSON");
  console.log("  --help, -h                Show this help");
}

function printSearchHelp(): void {
  console.log("Usage: agentlip search --query <text> [--limit N] [--workspace <path>] [--json]");
  console.log();
  console.log("Full-text search messages (requires FTS to be enabled).");
  console.log();
  console.log("Options:");
  console.log("  --query <text>      Search query (required, FTS5 syntax)");
  console.log("  --limit <n>         Max results to return (default: 50)");
  console.log("  --workspace <path>  Explicit workspace root");
  console.log("  --json              Output as JSON");
  console.log("  --help, -h          Show this help");
  console.log();
  console.log("Exit codes:");
  console.log("  0  OK");
  console.log("  1  Error (FTS not available, workspace not found, etc.)");
}

function printListenHelp(): void {
  console.log("Usage: agentlip listen [--since <event_id>] [--channel <name|id>...] [--topic-id <id>...] [--workspace <path>]");
  console.log();
  console.log("Stream events from hub via WebSocket (JSONL output to stdout).");
  console.log();
  console.log("Options:");
  console.log("  --since <event_id>  Start from this event ID (default: 0, all history)");
  console.log("  --channel <name|id> Filter by channel (can specify multiple times)");
  console.log("  --topic-id <id>     Filter by topic ID (can specify multiple times)");
  console.log("  --workspace <path>  Explicit workspace root (default: auto-discover)");
  console.log("  --help, -h          Show this help");
  console.log();
  console.log("If no --channel or --topic-id filters are specified, subscribes to ALL events.");
  console.log();
  console.log("Auto-reconnects on disconnect with exponential backoff (1s to 30s).");
  console.log("Deduplicates events on reconnect. Press Ctrl+C to exit.");
  console.log();
  console.log("Exit codes:");
  console.log("  0  Normal exit (Ctrl+C)");
  console.log("  1  Error (workspace not found, etc.)");
  console.log("  3  Hub not running (server.json not found)");
  console.log("  4  Authentication failed");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main CLI entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)) {
  // Handle global help
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  // Parse global options from entire argv first, then extract command
  const { globalOpts, remainingArgs: argsAfterGlobal } = parseGlobalOptions(argv);
  const [command, ...remainingArgs] = argsAfterGlobal;

  // ─── doctor ───
  if (command === "doctor") {
    if (remainingArgs.includes("--help") || remainingArgs.includes("-h")) {
      printDoctorHelp();
      process.exit(0);
    }
    const result = await runDoctor(globalOpts);
    output(result, globalOpts.json ?? false, () => printHumanDoctor(result));
    process.exit(result.status === "ok" ? 0 : 1);
  }

  // ─── channel ───
  if (command === "channel") {
    const [subcommand, ...subArgs] = remainingArgs;
    
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printChannelHelp();
      process.exit(0);
    }
    
    if (subcommand === "list") {
      if (subArgs.includes("--help") || subArgs.includes("-h")) {
        printChannelHelp();
        process.exit(0);
      }
      const result = await runChannelList(globalOpts);
      output(result, globalOpts.json ?? false, () => printHumanChannelList(result));
      process.exit(result.status === "ok" ? 0 : 1);
    }
    
    console.error(`Unknown channel subcommand: ${subcommand}`);
    process.exit(1);
  }

  // ─── topic ───
  if (command === "topic") {
    const [subcommand, ...subArgs] = remainingArgs;
    
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printTopicHelp();
      process.exit(0);
    }
    
    if (subcommand === "list") {
      if (subArgs.includes("--help") || subArgs.includes("-h")) {
        printTopicHelp();
        process.exit(0);
      }
      
      // Parse topic list options
      let channelId: string | undefined;
      let limit: number | undefined;
      let offset: number | undefined;
      
      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i];
        if (arg === "--channel-id") {
          channelId = subArgs[++i];
        } else if (arg === "--limit") {
          limit = parseInt(subArgs[++i], 10);
        } else if (arg === "--offset") {
          offset = parseInt(subArgs[++i], 10);
        }
      }
      
      if (!channelId) {
        console.error("--channel-id is required");
        process.exit(1);
      }
      
      const result = await runTopicList({ ...globalOpts, channelId, limit, offset });
      output(result, globalOpts.json ?? false, () => printHumanTopicList(result));
      process.exit(result.status === "ok" ? 0 : 1);
    }
    
    if (subcommand === "rename") {
      if (subArgs.includes("--help") || subArgs.includes("-h")) {
        printTopicHelp();
        process.exit(0);
      }
      
      const [topicId, ...renameArgs] = subArgs;
      if (!topicId) {
        console.error("<topic_id> is required");
        process.exit(1);
      }
      
      let title: string | undefined;
      
      for (let i = 0; i < renameArgs.length; i++) {
        const arg = renameArgs[i];
        if (arg === "--title") {
          title = renameArgs[++i];
        }
      }
      
      if (!title) {
        console.error("--title is required");
        process.exit(1);
      }
      
      const result = await runTopicRename({ ...globalOpts, topicId, title });
      if (result.status === "error" && result.code) {
        handleMutationError({ error: result.error!, code: result.code, status: 400 }, globalOpts.json ?? false);
      }
      output(result, globalOpts.json ?? false, () => printHumanTopicRename(result));
      process.exit(result.status === "ok" ? 0 : 1);
    }
    
    console.error(`Unknown topic subcommand: ${subcommand}`);
    process.exit(1);
  }

  // ─── msg ───
  if (command === "msg") {
    const [subcommand, ...subArgs] = remainingArgs;
    
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printMsgHelp();
      process.exit(0);
    }
    
    if (subcommand === "tail") {
      if (subArgs.includes("--help") || subArgs.includes("-h")) {
        printMsgHelp();
        process.exit(0);
      }
      
      let topicId: string | undefined;
      let limit: number | undefined;
      
      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i];
        if (arg === "--topic-id") {
          topicId = subArgs[++i];
        } else if (arg === "--limit") {
          limit = parseInt(subArgs[++i], 10);
        }
      }
      
      if (!topicId) {
        console.error("--topic-id is required");
        process.exit(1);
      }
      
      const result = await runMsgTail({ ...globalOpts, topicId, limit });
      output(result, globalOpts.json ?? false, () => printHumanMsgList(result));
      process.exit(result.status === "ok" ? 0 : 1);
    }
    
    if (subcommand === "page") {
      if (subArgs.includes("--help") || subArgs.includes("-h")) {
        printMsgHelp();
        process.exit(0);
      }
      
      let topicId: string | undefined;
      let beforeId: string | undefined;
      let afterId: string | undefined;
      let limit: number | undefined;
      
      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i];
        if (arg === "--topic-id") {
          topicId = subArgs[++i];
        } else if (arg === "--before-id") {
          beforeId = subArgs[++i];
        } else if (arg === "--after-id") {
          afterId = subArgs[++i];
        } else if (arg === "--limit") {
          limit = parseInt(subArgs[++i], 10);
        }
      }
      
      if (!topicId) {
        console.error("--topic-id is required");
        process.exit(1);
      }
      
      const result = await runMsgPage({ ...globalOpts, topicId, beforeId, afterId, limit });
      output(result, globalOpts.json ?? false, () => printHumanMsgList(result));
      process.exit(result.status === "ok" ? 0 : 1);
    }
    
    if (subcommand === "send") {
      if (subArgs.includes("--help") || subArgs.includes("-h")) {
        printMsgHelp();
        process.exit(0);
      }
      
      let topicId: string | undefined;
      let sender: string | undefined;
      let content: string | undefined;
      let stdin = false;
      
      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i];
        if (arg === "--topic-id") {
          topicId = subArgs[++i];
        } else if (arg === "--sender") {
          sender = subArgs[++i];
        } else if (arg === "--content") {
          content = subArgs[++i];
        } else if (arg === "--stdin") {
          stdin = true;
        }
      }
      
      if (!topicId) {
        console.error("--topic-id is required");
        process.exit(1);
      }
      if (!sender) {
        console.error("--sender is required");
        process.exit(1);
      }
      
      const result = await runMsgSend({ ...globalOpts, topicId, sender, content, stdin });
      if (result.status === "error" && result.code) {
        handleMutationError({ error: result.error!, code: result.code, status: 400 }, globalOpts.json ?? false);
      }
      output(result, globalOpts.json ?? false, () => printHumanMsgSend(result));
      process.exit(result.status === "ok" ? 0 : 1);
    }
    
    if (subcommand === "edit") {
      if (subArgs.includes("--help") || subArgs.includes("-h")) {
        printMsgHelp();
        process.exit(0);
      }
      
      const [messageId, ...editArgs] = subArgs;
      if (!messageId) {
        console.error("<message_id> is required");
        process.exit(1);
      }
      
      let content: string | undefined;
      let expectedVersion: number | undefined;
      
      for (let i = 0; i < editArgs.length; i++) {
        const arg = editArgs[i];
        if (arg === "--content") {
          content = editArgs[++i];
        } else if (arg === "--expected-version") {
          expectedVersion = parseInt(editArgs[++i], 10);
        }
      }
      
      if (!content) {
        console.error("--content is required");
        process.exit(1);
      }
      
      const result = await runMsgEdit({ ...globalOpts, messageId, content, expectedVersion });
      if (result.status === "error" && result.code) {
        handleMutationError({ error: result.error!, code: result.code, status: 400, details: result.details }, globalOpts.json ?? false);
      }
      output(result, globalOpts.json ?? false, () => printHumanMsgEdit(result));
      process.exit(result.status === "ok" ? 0 : 1);
    }
    
    if (subcommand === "delete") {
      if (subArgs.includes("--help") || subArgs.includes("-h")) {
        printMsgHelp();
        process.exit(0);
      }
      
      const [messageId, ...deleteArgs] = subArgs;
      if (!messageId) {
        console.error("<message_id> is required");
        process.exit(1);
      }
      
      let actor: string | undefined;
      let expectedVersion: number | undefined;
      
      for (let i = 0; i < deleteArgs.length; i++) {
        const arg = deleteArgs[i];
        if (arg === "--actor") {
          actor = deleteArgs[++i];
        } else if (arg === "--expected-version") {
          expectedVersion = parseInt(deleteArgs[++i], 10);
        }
      }
      
      if (!actor) {
        console.error("--actor is required");
        process.exit(1);
      }
      
      const result = await runMsgDelete({ ...globalOpts, messageId, actor, expectedVersion });
      if (result.status === "error" && result.code) {
        handleMutationError({ error: result.error!, code: result.code, status: 400, details: result.details }, globalOpts.json ?? false);
      }
      output(result, globalOpts.json ?? false, () => printHumanMsgDelete(result));
      process.exit(result.status === "ok" ? 0 : 1);
    }
    
    if (subcommand === "retopic") {
      if (subArgs.includes("--help") || subArgs.includes("-h")) {
        printMsgHelp();
        process.exit(0);
      }
      
      const [messageId, ...retopicArgs] = subArgs;
      if (!messageId) {
        console.error("<message_id> is required");
        process.exit(1);
      }
      
      let toTopicId: string | undefined;
      let mode: "one" | "later" | "all" | undefined;
      let force = false;
      let expectedVersion: number | undefined;
      
      for (let i = 0; i < retopicArgs.length; i++) {
        const arg = retopicArgs[i];
        if (arg === "--to-topic-id") {
          toTopicId = retopicArgs[++i];
        } else if (arg === "--mode") {
          const modeStr = retopicArgs[++i];
          if (!["one", "later", "all"].includes(modeStr)) {
            console.error("--mode must be one of: one, later, all");
            process.exit(1);
          }
          mode = modeStr as "one" | "later" | "all";
        } else if (arg === "--force") {
          force = true;
        } else if (arg === "--expected-version") {
          expectedVersion = parseInt(retopicArgs[++i], 10);
        }
      }
      
      if (!toTopicId) {
        console.error("--to-topic-id is required");
        process.exit(1);
      }
      if (!mode) {
        console.error("--mode is required");
        process.exit(1);
      }
      
      const result = await runMsgRetopic({ ...globalOpts, messageId, toTopicId, mode, force, expectedVersion });
      if (result.status === "error" && result.code) {
        handleMutationError({ error: result.error!, code: result.code, status: 400, details: result.details }, globalOpts.json ?? false);
      }
      output(result, globalOpts.json ?? false, () => printHumanMsgRetopic(result));
      process.exit(result.status === "ok" ? 0 : 1);
    }
    
    console.error(`Unknown msg subcommand: ${subcommand}`);
    process.exit(1);
  }

  // ─── attachment ───
  if (command === "attachment") {
    const [subcommand, ...subArgs] = remainingArgs;
    
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printAttachmentHelp();
      process.exit(0);
    }
    
    if (subcommand === "list") {
      if (subArgs.includes("--help") || subArgs.includes("-h")) {
        printAttachmentHelp();
        process.exit(0);
      }
      
      let topicId: string | undefined;
      let kind: string | undefined;
      
      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i];
        if (arg === "--topic-id") {
          topicId = subArgs[++i];
        } else if (arg === "--kind") {
          kind = subArgs[++i];
        }
      }
      
      if (!topicId) {
        console.error("--topic-id is required");
        process.exit(1);
      }
      
      const result = await runAttachmentList({ ...globalOpts, topicId, kind });
      output(result, globalOpts.json ?? false, () => printHumanAttachmentList(result));
      process.exit(result.status === "ok" ? 0 : 1);
    }
    
    if (subcommand === "add") {
      if (subArgs.includes("--help") || subArgs.includes("-h")) {
        printAttachmentHelp();
        process.exit(0);
      }
      
      let topicId: string | undefined;
      let kind: string | undefined;
      let valueJson: string | undefined;
      let key: string | undefined;
      let sourceMessageId: string | undefined;
      let dedupeKey: string | undefined;
      
      for (let i = 0; i < subArgs.length; i++) {
        const arg = subArgs[i];
        if (arg === "--topic-id") {
          topicId = subArgs[++i];
        } else if (arg === "--kind") {
          kind = subArgs[++i];
        } else if (arg === "--value-json") {
          valueJson = subArgs[++i];
        } else if (arg === "--key") {
          key = subArgs[++i];
        } else if (arg === "--source-message-id") {
          sourceMessageId = subArgs[++i];
        } else if (arg === "--dedupe-key") {
          dedupeKey = subArgs[++i];
        }
      }
      
      if (!topicId) {
        console.error("--topic-id is required");
        process.exit(1);
      }
      if (!kind) {
        console.error("--kind is required");
        process.exit(1);
      }
      if (!valueJson) {
        console.error("--value-json is required");
        process.exit(1);
      }
      
      const result = await runAttachmentAdd({ 
        ...globalOpts, 
        topicId, 
        kind, 
        valueJson, 
        key, 
        sourceMessageId, 
        dedupeKey 
      });
      if (result.status === "error" && result.code) {
        handleMutationError({ error: result.error!, code: result.code, status: 400 }, globalOpts.json ?? false);
      }
      output(result, globalOpts.json ?? false, () => printHumanAttachmentAdd(result));
      process.exit(result.status === "ok" ? 0 : 1);
    }
    
    console.error(`Unknown attachment subcommand: ${subcommand}`);
    process.exit(1);
  }

  // ─── search ───
  if (command === "search") {
    if (remainingArgs.includes("--help") || remainingArgs.includes("-h")) {
      printSearchHelp();
      process.exit(0);
    }
    
    let query: string | undefined;
    let limit: number | undefined;
    
    for (let i = 0; i < remainingArgs.length; i++) {
      const arg = remainingArgs[i];
      if (arg === "--query" || arg === "-q") {
        query = remainingArgs[++i];
      } else if (arg === "--limit") {
        limit = parseInt(remainingArgs[++i], 10);
      }
    }
    
    if (!query) {
      console.error("--query is required");
      process.exit(1);
    }
    
    const result = await runSearch({ ...globalOpts, query, limit });
    output(result, globalOpts.json ?? false, () => printHumanSearch(result));
    process.exit(result.status === "ok" ? 0 : 1);
  }

  // ─── listen ───
  if (command === "listen") {
    if (remainingArgs.includes("--help") || remainingArgs.includes("-h")) {
      printListenHelp();
      process.exit(0);
    }
    
    let since = 0;
    const channels: string[] = [];
    const topicIds: string[] = [];
    
    for (let i = 0; i < remainingArgs.length; i++) {
      const arg = remainingArgs[i];
      if (arg === "--since") {
        since = parseInt(remainingArgs[++i], 10);
        if (isNaN(since) || since < 0) {
          console.error("--since must be a non-negative integer");
          process.exit(1);
        }
      } else if (arg === "--channel") {
        const value = remainingArgs[++i];
        if (!value) {
          console.error("--channel requires a value");
          process.exit(1);
        }
        channels.push(value);
      } else if (arg === "--topic-id") {
        const value = remainingArgs[++i];
        if (!value) {
          console.error("--topic-id requires a value");
          process.exit(1);
        }
        topicIds.push(value);
      } else if (arg === "--format") {
        // Only jsonl is supported; accept but ignore
        const value = remainingArgs[++i];
        if (value !== "jsonl") {
          console.error("Only --format jsonl is supported");
          process.exit(1);
        }
      }
    }
    
    // Run listen (this is a long-running command)
    await runListen({
      ...globalOpts,
      since,
      channels,
      topicIds,
    });
    
    // Should not reach here unless cleanly exited
    process.exit(0);
  }

  // ─── unknown ───
  console.error(`Unknown command: ${command}`);
  console.error("Use --help for usage information");
  process.exit(1);
}

// Run if executed directly
if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
