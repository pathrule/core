// SPDX-License-Identifier: Apache-2.0
/**
 * KnowledgeBackend — the single seam between @pathrule/core's MCP tool surface
 * and its storage + intelligence layer.
 *
 *   LocalBackend  (open, SQLite) implements this for the self-hosted solo edition.
 *   The hosted edition implements the same contract over its own storage.
 *
 * The AI client sees an identical MCP tool contract regardless of which backend is
 * injected; only the optional capabilities (routeIntent / semanticCandidates) and the
 * `capabilities()` flags differ.
 *
 * Domain types (Memory/Rule/Skill, the intelligence result shapes, …) live in
 * @pathrule/shared and are imported here: @pathrule/shared is the lower, dependency-free
 * contracts layer that this package builds on. core imports shared; the dependency only
 * ever flows one way (enforced by the dependency guard).
 */
import type { Memory, Rule, Skill } from "@pathrule/shared/content-types.js";
import type { HookIndex } from "@pathrule/shared/hook-supervisor/types.js";
import type {
  ProjectMapSearchResult,
  HotPath,
  PriorSolution,
  NodeBrief,
  WorkEpisodeBrief,
  ResearchBriefing,
  AssembleBriefingInput,
  RecentActivityForRouter,
} from "@pathrule/shared/intelligence/types.js";
import type { TreeNode } from "@pathrule/shared/node-types.js";
import type {
  RoutingResult,
  SubtreeMemoryIndexEntry,
  SubtreeMemoryIndexResult,
} from "@pathrule/shared/routing-types.js";
import type { DedupCheckArgs, DedupCheckResult } from "@pathrule/shared/tools/dedup-types.js";
import type { MaterialisedNode } from "@pathrule/shared/tools/node-path.js";
import type { WorkspaceOverviewNode } from "@pathrule/shared/tools/overview.js";
import type {
  RefreshRow,
  PendingRefreshSummary,
  RequestRefreshResult,
} from "@pathrule/shared/tools/refresh-types.js";
import type { BackendCapabilities } from "./capabilities.js";
import type {
  ContextScope,
  WriteMemoryInput,
  UpdateMemoryInput,
  ListMemoriesQuery,
  DeleteContentInput,
  DeleteContentResult,
  RestoreContentResult,
  WriteRuleInput,
  UpdateRuleInput,
  ListRulesQuery,
  WriteSkillInput,
  UpdateSkillInput,
  ListSkillsQuery,
  LogActivityInput,
  ActivityRecord,
  Activity,
  RequestRefreshInput,
  NodeDetailRecord,
  NodeRef,
  NodeContent,
  InvocationSkill,
  RelevantMemoryRow,
  RouteIntentInput,
  SemanticQuery,
  SemanticCandidatesResult,
  WorkspaceMatch,
  ClosestNode,
} from "./inputs.js";

export interface KnowledgeBackend {
  // ── lifecycle ──────────────────────────────────────────────────────────
  /** Whether the current session is still valid. LocalBackend: always true (single user). */
  sessionIsCurrent(): Promise<boolean>;

  // ── memory CRUD ────────────────────────────────────────────────────────
  readMemory(id: string): Promise<Memory | null>;
  writeMemory(input: WriteMemoryInput): Promise<Memory>;
  updateMemory(input: UpdateMemoryInput): Promise<Memory>;
  deleteMemory(input: DeleteContentInput): Promise<DeleteContentResult>;
  /** Restore a soft-deleted (archived) memory to active. */
  restoreMemory(id: string): Promise<RestoreContentResult>;
  listMemories(query: ListMemoriesQuery): Promise<Memory[]>;

  // ── rule CRUD ──────────────────────────────────────────────────────────
  readRule(id: string): Promise<Rule | null>;
  /** Creates the rule and, when nodeId is supplied, attaches it to that node. */
  writeRule(input: WriteRuleInput): Promise<Rule>;
  /** Updates rule fields and, when nodeId is supplied, re-homes its node attachment. */
  updateRule(input: UpdateRuleInput): Promise<Rule>;
  deleteRule(input: DeleteContentInput): Promise<DeleteContentResult>;
  /** Restore a soft-deleted (archived) rule to active. */
  restoreRule(id: string): Promise<RestoreContentResult>;
  listRules(query: ListRulesQuery): Promise<Rule[]>;

  // ── skill CRUD ─────────────────────────────────────────────────────────
  /** Returns the skill with its effective content — the backend resolves any package
   *  primary (SKILL.md) vs inline body internally, so callers get a usable body. */
  readSkill(id: string): Promise<Skill | null>;
  /** Creates the skill and, when nodeId is supplied, attaches it to that node. */
  writeSkill(input: WriteSkillInput): Promise<Skill>;
  /** Updates skill fields and, when nodeId is supplied, re-homes its node attachment. */
  updateSkill(input: UpdateSkillInput): Promise<Skill>;
  deleteSkill(input: DeleteContentInput): Promise<DeleteContentResult>;
  /** Restore a soft-deleted (archived) skill to active. */
  restoreSkill(id: string): Promise<RestoreContentResult>;
  listSkills(query: ListSkillsQuery): Promise<Skill[]>;

  // ── workspace resolution ─────────────────────────────────────────────────
  /**
   * Resolve a cwd → workspace (longest local-root-path prefix). The hosted
   * edition resolves against the caller's registered workspace paths; the
   * self-hosted edition resolves from its local `workspaces` rows.
   * `null` ⇒ no workspace covers this path (handler surfaces a clean error).
   */
  resolveWorkspaceFromCwd(cwd: string): Promise<WorkspaceMatch | null>;
  /**
   * Walk up from a relative path to the closest node that exists (the workspace
   * root node has relative_path ""/"/"). `null` ⇒ the workspace has no nodes.
   */
  closestNode(workspaceId: string, relativePath: string): Promise<ClosestNode | null>;

  // ── tree ───────────────────────────────────────────────────────────────
  getTree(workspaceId: string): Promise<TreeNode[]>;
  /** A single node by id (access-scoped per edition). Used to resolve a content row's node path. */
  getNode(nodeId: string): Promise<TreeNode | null>;
  /** A node plus its directly-attached memory/rule/skill ids (backs the get_node tool). */
  getNodeDetail(nodeId: string): Promise<NodeDetailRecord | null>;
  /**
   * Every non-empty node in the workspace with its memory/rule/skill titles inline
   * (the llms.txt-style router index). semantic_tags are inferred when absent.
   */
  workspaceOverview(workspaceId: string, excludeNodeId?: string): Promise<WorkspaceOverviewNode[]>;
  /** Resolve a node by its exact workspace-relative path. */
  findNodeByPath(workspaceId: string, relativePath: string): Promise<NodeRef | null>;
  /** Raw memory/rule/skill content attached to a node (bodies included; handler shapes it). */
  getNodeContent(nodeId: string): Promise<NodeContent>;
  /** All active workspace skills with EFFECTIVE content, for ::skill-name invocation matching. */
  listSkillsForInvocation(workspaceId: string): Promise<InvocationSkill[]>;
  /** The first node a rule is attached to, or null if unattached. */
  getNodeForRule(ruleId: string): Promise<TreeNode | null>;
  /** The first node a skill is attached to, or null if unattached. */
  getNodeForSkill(skillId: string): Promise<TreeNode | null>;
  /**
   * Find or create the node chain for a workspace-relative path (path-first writes).
   * Missing ancestors materialise as folders; the leaf type is inferred unless given. Throws on failure.
   */
  ensureNodeForPath(
    workspaceId: string,
    path: string,
    leafType?: "folder" | "file" | "context",
  ): Promise<MaterialisedNode>;

  // ── write guards / dedup ─────────────────────────────────────────────────
  /** Read-only demo workspace (hosted edition only); false everywhere else. */
  isDemoWorkspace(workspaceId: string): Promise<boolean>;
  /** Normalised duplicate + fuzzy-similar pre-check for a memory/rule/skill title. */
  checkContentDedup(args: DedupCheckArgs): Promise<DedupCheckResult>;

  // ── context formulas (the get_context discovery + deep-briefing engine inputs) ──
  /**
   * Descendant memory titles for a path subtree. Returns the full result —
   * entries + truncated + total — that the get_context discovery surface
   * consumes. Empty scope path ("/") covers the whole workspace.
   */
  subtreeMemoryIndex(scope: ContextScope, limit: number): Promise<SubtreeMemoryIndexResult>;
  /**
   * Fuzzy "problem text → relevant content-bearing nodes" search. Ranks every
   * node carrying ≥1 memory/rule/skill by weighted trigram word-similarity
   * against its path/name/titles/body, keeping matches ≥ 0.30 (post-weight).
   * Returns ranked NodeBriefs (relevance 0–1, desc) + the top raw score.
   */
  projectMapSearch(
    workspaceId: string,
    query: string,
    limit?: number,
  ): Promise<ProjectMapSearchResult>;
  /**
   * Top-5 most-changed paths in the last 7 days. The hosted edition reads a
   * dedicated change feed; LocalBackend/InMemory derive from their own
   * `activity_logs` (populated by `logActivity`). Empty when there's no recent activity.
   */
  getHotPaths(workspaceId: string): Promise<HotPath[]>;
  /**
   * Snapshot the workspace-relative paths active when a memory was written, for later
   * prior-solutions ranking. The hosted edition reads its recent change feed;
   * LocalBackend/InMemory read their recent `activity_logs`. Best-effort —
   * callers fire-and-forget; a no-op when there's no recent activity.
   */
  recordMemoryContextPaths(memoryId: string, workspaceId: string): Promise<void>;
  /**
   * Top-N memories whose recorded context paths overlap `matchedPaths`, newest first.
   * Empty when matchedPaths is empty or nothing overlaps.
   */
  rankPriorSolutions(
    workspaceId: string,
    matchedPaths: string[],
    limit?: number,
  ): Promise<PriorSolution[]>;
  /**
   * Nodes that change together with the seeds. The hosted edition walks a
   * materialized co-change graph; LocalBackend/InMemory derive coupling on-read
   * from `activity_logs` (paths touched together in one activity). `changeLogCount`
   * tunes the hosted git/runtime blend; the local derivation ignores it. NodeBriefs
   * carry match_source "co_change" and relevance = min(1, weight/10); empty when
   * there are no seeds or no signal.
   */
  findCoupledNodes(
    workspaceId: string,
    seedNodeIds: string[],
    seedPaths: string[],
    changeLogCount: number,
  ): Promise<NodeBrief[]>;
  /**
   * Materialize/refresh work episodes from activity. The hosted edition upserts a
   * materialized table (throttled); LocalBackend/InMemory cluster on-read in
   * `searchWorkEpisodes`, so this is a no-op returning {ok:true, 0}.
   */
  refreshWorkEpisodes(
    workspaceId: string,
    since?: string,
  ): Promise<{ ok: boolean; episodes_upserted: number }>;
  /**
   * Episodes relevant to `query`, newest first. The hosted edition reads a
   * materialized table; LocalBackend/InMemory cluster `activity_logs`
   * deterministically (no LLM titles). `limit` is the caller's compact/deep budget.
   */
  searchWorkEpisodes(
    workspaceId: string,
    query: string,
    mode: "compact" | "deep",
    limit: number,
  ): Promise<WorkEpisodeBrief[]>;
  /**
   * Compose the deep-mode research briefing from the engine outputs. The backend
   * computes prior_solutions internally from the primary paths, dedups, ranks
   * suggested_order, and trims to budget.
   */
  assembleBriefing(input: AssembleBriefingInput): Promise<ResearchBriefing>;
  /**
   * UNION of node-owner (memories on the path's node + ancestors) and context-link memories
   * (memory_context_paths overlapping the path), node-owner winning duplicates. Each row
   * carries a `via` label for telemetry.
   */
  relevantMemoriesForPath(
    workspaceId: string,
    path: string,
    limit?: number,
  ): Promise<RelevantMemoryRow[]>;
  /**
   * The full offline hook-index payload: path memory/rule stubs, project rules,
   * recent subjects, session digest, filename + skill invocation indexes, work
   * episodes, refresh counts. LocalBackend/InMemory assemble it from their store
   * (hosted-only curation fields omitted). `workspace_root` is left empty for the
   * CLI writer to fill. Null only when unavailable.
   */
  buildHookIndexPayload(workspaceId: string): Promise<HookIndex | null>;

  // ── activity ───────────────────────────────────────────────────────────
  /**
   * Persists an activity row and returns it. The hosted edition additionally stamps the
   * session/user, friction counts, and fires the applied-memory signal; LocalBackend
   * persists the core row only (friction + applied-memory are hosted-only intelligence).
   */
  logActivity(input: LogActivityInput): Promise<ActivityRecord>;
  recentActivities(scope: ContextScope, limit: number): Promise<Activity[]>;
  /**
   * Recent activities in the get_context router/briefing shape (snake_case + node_path
   * + files_touched). The hosted edition filters by `userId`; LocalBackend ignores it
   * (single principal). Never throws — returns [] on any backend hiccup.
   */
  recentActivitiesForRouter(
    workspaceId: string,
    limit: number,
    userId?: string | null,
  ): Promise<RecentActivityForRouter[]>;

  // ── refresh queue (queue mechanics work locally; the AI brief populator is hosted-only) ──
  /** Open refresh tasks projected onto the summary shape. */
  listPendingRefreshes(
    workspaceId: string,
    includeInProgress?: boolean,
  ): Promise<PendingRefreshSummary[]>;
  /** Claim-on-read: a pending task transitions to in_progress and the full brief is returned. */
  getRefreshBrief(refreshId: string, claimedBy?: string): Promise<RefreshRow>;
  /**
   * Close a task. The hosted edition also mirrors the suggestion, writes a dismissal window,
   * and notifies the subject creator + admins; LocalBackend only flips the status.
   */
  resolveRefresh(
    refreshId: string,
    status: "applied" | "rejected",
    note?: string,
    claimedBy?: string,
  ): Promise<RefreshRow>;
  /** File a refresh against a concrete memory/rule subject. Idempotent per open subject. */
  requestRefresh(input: RequestRefreshInput): Promise<RequestRefreshResult>;

  // ── optional capabilities (return null when unsupported) ─────────────────
  /**
   * LLM intent router. Present only when a router LLM is reachable (the hosted
   * edition's service, or a bring-your-own `PATHRULE_AI_ROUTE_KEY` locally).
   * Returns a full RoutingResult (decision + fallback + latency_ms) so get_context
   * can degrade to the deterministic router on a fallback. `null` ⇒ capability not wired.
   */
  routeIntent?(input: RouteIntentInput): Promise<RoutingResult | null>;
  /**
   * Embedding-based memory retrieval for get_context's additive
   * `semantic_candidates` field. Present only when a vector store + embedding
   * key exist (the hosted edition's service, or a bring-your-own embedding key
   * locally). Returns the shaped payload + skip/latency the handler consumes;
   * `null` ⇒ capability not wired (field omitted, all other surfaces intact).
   */
  semanticCandidates?(query: SemanticQuery): Promise<SemanticCandidatesResult | null>;

  /** Static description of what this backend can fill. */
  capabilities(): BackendCapabilities;
}
