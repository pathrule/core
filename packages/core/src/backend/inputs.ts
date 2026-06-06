// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical input / auxiliary contract types owned by @pathrule/core.
 * Every backend implements KnowledgeBackend against these, so the contract —
 * not a storage client — is the source of truth.
 */

/** A path within a workspace — the scope most context calls resolve against. */
export interface ContextScope {
  workspaceId: string;
  relativePath: string;
}

// ── Memory ────────────────────────────────────────────────────────────────
export interface WriteMemoryInput {
  workspaceId: string;
  nodeId?: string;
  title: string;
  content: string;
  source?: "claude" | "manual";
  relatedPaths?: string[];
}
export interface UpdateMemoryInput {
  id: string;
  title?: string;
  content?: string;
  /** Re-home the memory to a different node (the move_to_path target, already resolved). */
  nodeId?: string;
}
export interface ListMemoriesQuery {
  workspaceId: string;
  nodeId?: string;
  status?: "active" | "archived";
}

// ── Delete (shared by memory/rule/skill) ─────────────────────────────────────
export interface DeleteContentInput {
  id: string;
  /** Hard delete (purge) vs the default soft delete (archive). */
  hard?: boolean;
  /** Optimistic concurrency token — a soft delete conflicts if it no longer matches. */
  expectedVersionId?: string;
}
/** Discriminated delete outcome so callers map to their own error contract without throwing. */
export type DeleteContentResult =
  | { status: "deleted"; id: string; workspaceId: string; nodeId: string | null }
  | { status: "conflict"; currentVersionId: string }
  | { status: "rejected"; reason: string };

/**
 * Discriminated restore outcome (archived → active). `reason` carries a stable error
 * string ("not_found" | "not_deleted" | "forbidden" | …) the handler maps to its error contract.
 */
export type RestoreContentResult =
  | { status: "restored"; id: string; workspaceId: string; nodeId: string | null }
  | { status: "rejected"; reason: string };

// ── Rule ──────────────────────────────────────────────────────────────────
export interface WriteRuleInput {
  workspaceId: string;
  nodeId?: string;
  name: string;
  content: string;
  scopeType: "folder" | "file_type" | "project";
  priority?: "high" | "medium" | "low";
}
export interface UpdateRuleInput {
  id: string;
  name?: string;
  content?: string;
  scopeType?: "folder" | "file_type" | "project";
  priority?: "high" | "medium" | "low";
  /** Re-home the rule's node attachment (the move_to_path target, already resolved). */
  nodeId?: string;
}
export interface ListRulesQuery {
  workspaceId: string;
  nodeId?: string;
  status?: "active" | "archived";
}

// ── Skill ─────────────────────────────────────────────────────────────────
export interface WriteSkillInput {
  workspaceId: string;
  nodeId?: string;
  name: string;
  content: string;
  description?: string | null;
  source?: "manual" | "template" | "github_ref";
  githubUrl?: string | null;
  tags?: string[];
}
export interface UpdateSkillInput {
  id: string;
  name?: string;
  content?: string;
  /** null clears the description; undefined keeps it. */
  description?: string | null;
  source?: "manual" | "template" | "github_ref";
  /** null clears the URL; undefined keeps it. */
  githubUrl?: string | null;
  tags?: string[];
  /** Re-home the skill's node attachment (the move_to_path target, already resolved). */
  nodeId?: string;
}
export interface ListSkillsQuery {
  workspaceId: string;
  nodeId?: string;
  status?: "active" | "archived";
}

// ── Activity ────────────────────────────────────────────────────────────────
/** Structured file inventory for an activity (the `files_touched` shape). */
export interface FilesTouchedInput {
  total: number;
  by_area: Record<string, string[]>;
}
/**
 * Friction counts (tool call/failure telemetry). Persisted only by the hosted edition,
 * which enforces failures ≤ calls and code shape; LocalBackend ignores them — friction
 * telemetry is a hosted-only intelligence surface.
 */
export interface ActivityFriction {
  toolCallCount?: number;
  toolFailureCount?: number;
  toolFailureCodes?: string[];
}
export interface LogActivityInput {
  workspaceId: string;
  nodePath?: string;
  domain: string;
  action: string;
  scope: string;
  subjects?: string[];
  taskSummary: string;
  filesTouched?: FilesTouchedInput;
  aiClient?: string;
  /** Hook session id. The hosted edition attributes friction + applied-memory signals to it; LocalBackend ignores. */
  sessionId?: string;
  /** Friction counts to persist (hosted-only). */
  friction?: ActivityFriction;
  /**
   * Explicit positive signal — memory ids the agent actually applied this turn.
   * The hosted edition records them to its affinity model; LocalBackend ignores
   * (the affinity model is a hosted-only curation surface).
   */
  appliedMemoryIds?: string[];
}
/** The persisted activity row, returned by `logActivity` so callers can echo id/created_at. */
export interface ActivityRecord {
  id: string;
  workspaceId: string;
  nodePath: string;
  domain: string;
  action: string;
  scope: string;
  subjects: string[];
  taskSummary: string;
  filesTouched: FilesTouchedInput;
  aiClient: string;
  /** Display fields populated by the hosted edition; LocalBackend defaults them. */
  detailLevel?: string;
  status?: string;
  createdAt: string;
  toolCallCount?: number;
  toolFailureCount?: number;
  toolFailureCodes?: string[];
}
/** Lean activity projection for `recentActivities` / context assembly. */
export interface Activity {
  id: string;
  nodePath: string | null;
  domain: string | null;
  action: string | null;
  taskSummary: string | null;
  createdAt: string;
}

// ── Refresh queue ───────────────────────────────────────────────────────────
// The rich queue contract (RefreshRow / RefreshBrief / PendingRefreshSummary /
// RequestRefreshResult / RefreshStatus) lives in @pathrule/shared and the backend
// interface imports it from there (type-only). Core owns only the request *input*
// shape below — keyed by a concrete memory/rule subject.
export type RequestRefreshKind =
  | "drift"
  | "contradicts_code"
  | "duplicate"
  | "too_narrow"
  | "unclear";
export interface RequestRefreshInput {
  subjectType: "memory" | "rule";
  subjectId: string;
  reason: string;
  kind?: RequestRefreshKind;
}

// ── Tree / node detail ───────────────────────────────────────────────────────
/**
 * A node plus the ids of its directly-attached memories/rules/skills. Backs the
 * `get_node` tool (camelCase; the handler maps to its snake_case output contract).
 */
export interface NodeDetailRecord {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  type: string;
  relativePath: string;
  memoryIds: string[];
  ruleIds: string[];
  skillIds: string[];
}

/** A minimal node reference resolved by workspace-relative path (backs get_context step 1). */
export interface NodeRef {
  id: string;
  name: string;
  relativePath: string;
}

/**
 * Raw content attached to a node — bodies included so the handler can build previews +
 * infer semantic_tags. (The handler owns the presentation shaping; the backend owns the read.)
 */
export interface NodeContent {
  memories: Array<{
    id: string;
    title: string;
    content: string;
    semanticTags?: readonly string[] | null;
  }>;
  rules: Array<{
    id: string;
    name: string;
    content: string;
    scopeType: string;
    priority: string;
    semanticTags?: readonly string[] | null;
  }>;
  skills: Array<{
    id: string;
    name: string;
    description: string | null;
    source: string;
    tags?: string[] | null;
    semanticTags?: readonly string[] | null;
  }>;
}

/** A workspace skill with its EFFECTIVE content resolved — for ::skill-name invocation matching. */
export interface InvocationSkill {
  id: string;
  name: string;
  description: string | null;
  content: string;
  source: string;
  githubUrl: string | null;
}

// ── Relevant memories for a path (node-owner ∪ context-link union) ──────
export interface RelevantMemoryRow {
  memory_id: string;
  node_id: string;
  title: string;
  via: "node_owner" | "context_link";
  /** The context-link path that caused inclusion; null for node-owner hits. */
  matched_path: string | null;
  confidence: number | null;
}

// ── Optional (bring-your-own-key / hosted) capabilities ──────────────────────
// The canonical router input lives in @pathrule/shared so the MCP server's intent
// router, the KnowledgeBackend.routeIntent seam, and the bring-your-own ai-route
// adapter all share one shape. Re-exported here for backend implementers.
export type {
  RouteIntentInput,
  // Semantic candidates seam. Canonical shapes live in @pathrule/shared
  // (next to RouteIntentInput) so the hosted client, the KnowledgeBackend
  // seam, and the bring-your-own embedding adapter share one contract.
  SemanticQuery,
  SemanticCandidatesResult,
  SemanticCandidatesPayload,
  SemanticCandidateOut,
} from "@pathrule/shared/routing-types.js";
// Workspace resolution seam.
export type { WorkspaceMatch, ClosestNode } from "@pathrule/shared/node-types.js";
