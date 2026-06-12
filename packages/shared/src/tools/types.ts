// Shared tool-layer contracts used by the MCP server and any future in-app
// AI caller (e.g., a resurrected Edge-Function suggestion service).
//
// Handlers are pure functions: `(ctx, args) => ToolResult`. They read knowledge
// through the injected `backend` — no environment assumptions, no runtime
// fetches beyond the backend itself. This base context is deliberately
// cloud-free (no @supabase import) so it stays in the OSS local closure;
// cloud-only handlers take `CloudToolContext` (see ./cloud-context.ts), which
// adds the authenticated Supabase client.

import type { KnowledgeBackend } from "@pathrule/core";

import type { AgentTargetId } from "../skills/agent-targets.js";

/**
 * Every tool runs in this context. Knowledge is read through the injected
 * `backend`; cloud-only handlers extend this with an authenticated Supabase
 * client via `CloudToolContext`.
 */
export interface ToolContext {
  /**
   * The injected KnowledgeBackend — the single data source for tool handlers.
   * Optional only at the type level so composition sites can attach it as they
   * build the context. CloudBackend wraps a Supabase client; LocalBackend (OSS)
   * supplies SQLite.
   */
  backend?: KnowledgeBackend;
  /** `auth.users.id` of the caller. Stamped into writes (last_edited_by). */
  userId: string;
  /**
   * Default workspace id for the call chain. Some tools accept an explicit
   * `workspace_id` arg and override this; others (`get_context`) use it as the
   * resolved workspace. null when not yet resolved (e.g., before cwd matching).
   */
  workspaceId: string | null;
  /**
   * M19f — Resolved AI client identity for the call chain. Populated by the
   * MCP server from the transport handshake (`client_info.name`) or the
   * `MCP_CLIENT_NAME` env var. null when running outside an MCP transport
   * (e.g. inside the Electron renderer's direct tool calls). Tools that
   * stamp telemetry (`activity_logs.ai_client`, `suggestion_refreshes.claimed_by`)
   * default to this value when the caller didn't override.
   */
  clientId?: AgentTargetId | null;
}

export type ToolErrorCode =
  | "offline"
  | "auth_required"
  | "not_found"
  | "permission_denied"
  | "subscription_required"
  | "conflict"
  | "duplicate"
  | "invalid_args"
  | "upstream_error";

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  /** Optional machine-readable detail — e.g. current version id on conflict. */
  detail?: unknown;
}

/**
 * Non-fatal advisory attached to a successful tool result. Examples:
 *   • `similar_titles` — fuzzy near-duplicates surfaced by the dedup RPC after
 *     a memory/rule write succeeded. The caller decides whether to surface
 *     them to the user (UI banner) or to the agent (response field).
 */
export interface ToolWarning {
  code: "similar_titles";
  message?: string;
  detail?: unknown;
}

export type ToolResult<T> =
  | { ok: true; data: T; warnings?: ToolWarning[] }
  | { ok: false; error: ToolError };

export function okResult<T>(data: T, warnings?: ToolWarning[]): ToolResult<T> {
  return warnings && warnings.length > 0 ? { ok: true, data, warnings } : { ok: true, data };
}

export function errResult<T = never>(
  code: ToolErrorCode,
  message: string,
  detail?: unknown,
): ToolResult<T> {
  return { ok: false, error: { code, message, detail } };
}

/**
 * Narrow a Supabase PostgrestError into one of our canonical codes so callers
 * don't have to pattern-match on hrefs.
 */
export function mapSupabaseError(err: { code?: string; message: string }): ToolError {
  // RLS row-denial and "no row" come back as PGRST116; the distinction depends
  // on whether a row actually exists vs. is shadowed by RLS. We can't tell
  // from the error, so we default to permission_denied + include the message
  // for the caller to surface to Claude.
  if (err.code === "PGRST116") {
    return { code: "not_found", message: err.message };
  }
  if (err.code === "42501" /* Postgres permission denied */) {
    return { code: "permission_denied", message: err.message };
  }
  return { code: "upstream_error", message: err.message };
}

/**
 * Maps a string error code returned by a SECURITY DEFINER RPC body
 * (`delete_*_rpc`, `restore_*_rpc`) to the canonical ToolError shape.
 * `conflict` is handled by the caller separately because it carries
 * `current_version_id` detail.
 */
export function mapRpcError(rpcError: string): ToolError {
  switch (rpcError) {
    case "not_authenticated":
      return { code: "auth_required", message: "Sign in required." };
    case "forbidden":
      return { code: "permission_denied", message: "You don't have permission for this action." };
    case "not_found":
      return { code: "not_found", message: "Item not found." };
    case "already_deleted":
      return { code: "invalid_args", message: "Item is already deleted." };
    case "not_deleted":
      return { code: "invalid_args", message: "Item is not deleted — nothing to restore." };
    default:
      return { code: "upstream_error", message: `RPC error: ${rpcError}` };
  }
}
