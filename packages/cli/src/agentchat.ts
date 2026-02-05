#!/usr/bin/env bun
/**
 * agentchat CLI - stateless read-only queries and hub mutations
 * 
 * Commands:
 * - doctor: run diagnostics (DB integrity, schema version, etc.)
 * - channel list: list all channels
 * - topic list: list topics in a channel
 * - msg tail: get latest messages from a topic
 * - msg page: paginate messages with cursor
 * - attachment list: list topic attachments
 * - search: full-text search (if FTS available)
 */

import { openWorkspaceDbReadonly, isQueryOnly, WorkspaceNotFoundError, DatabaseNotFoundError } from "./index.js";
import {
  listChannels,
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
} from "@agentchat/kernel";
import type { Database } from "bun:sqlite";

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
// Help messages
// ─────────────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log("Usage: agentchat <command> [options]");
  console.log();
  console.log("Commands:");
  console.log("  doctor               Run diagnostics on workspace DB");
  console.log("  channel list         List all channels");
  console.log("  topic list           List topics in a channel");
  console.log("  msg tail             Get latest messages from a topic");
  console.log("  msg page             Paginate messages with cursor");
  console.log("  attachment list      List topic attachments");
  console.log("  search               Full-text search messages");
  console.log();
  console.log("Global options:");
  console.log("  --workspace <path>   Explicit workspace root (default: auto-discover)");
  console.log("  --json               Output as JSON");
  console.log("  --help, -h           Show this help");
  console.log();
  console.log("Use '<command> --help' for more information on a command.");
}

function printDoctorHelp(): void {
  console.log("Usage: agentchat doctor [--workspace <path>] [--json]");
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
  console.log("Usage: agentchat channel <subcommand> [options]");
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
  console.log("Usage: agentchat topic <subcommand> [options]");
  console.log();
  console.log("Subcommands:");
  console.log("  list    List topics in a channel");
  console.log();
  console.log("Usage: agentchat topic list --channel-id <id> [--limit N] [--offset N]");
  console.log();
  console.log("Options:");
  console.log("  --channel-id <id>   Channel ID (required)");
  console.log("  --limit <n>         Max topics to return (default: 50)");
  console.log("  --offset <n>        Offset for pagination (default: 0)");
  console.log("  --workspace <path>  Explicit workspace root");
  console.log("  --json              Output as JSON");
  console.log("  --help, -h          Show this help");
}

function printMsgHelp(): void {
  console.log("Usage: agentchat msg <subcommand> [options]");
  console.log();
  console.log("Subcommands:");
  console.log("  tail    Get latest messages from a topic");
  console.log("  page    Paginate messages with cursor");
  console.log();
  console.log("Usage: agentchat msg tail --topic-id <id> [--limit N]");
  console.log("       agentchat msg page --topic-id <id> [--before-id <id>] [--after-id <id>] [--limit N]");
  console.log();
  console.log("Options:");
  console.log("  --topic-id <id>     Topic ID (required)");
  console.log("  --before-id <id>    Get messages before this ID (page command)");
  console.log("  --after-id <id>     Get messages after this ID (page command)");
  console.log("  --limit <n>         Max messages to return (default: 50)");
  console.log("  --workspace <path>  Explicit workspace root");
  console.log("  --json              Output as JSON");
  console.log("  --help, -h          Show this help");
}

function printAttachmentHelp(): void {
  console.log("Usage: agentchat attachment <subcommand> [options]");
  console.log();
  console.log("Subcommands:");
  console.log("  list    List attachments for a topic");
  console.log();
  console.log("Usage: agentchat attachment list --topic-id <id> [--kind <kind>]");
  console.log();
  console.log("Options:");
  console.log("  --topic-id <id>     Topic ID (required)");
  console.log("  --kind <kind>       Filter by attachment kind");
  console.log("  --workspace <path>  Explicit workspace root");
  console.log("  --json              Output as JSON");
  console.log("  --help, -h          Show this help");
}

function printSearchHelp(): void {
  console.log("Usage: agentchat search --query <text> [--limit N] [--workspace <path>] [--json]");
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
