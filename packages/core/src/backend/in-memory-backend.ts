// SPDX-License-Identifier: Apache-2.0
/**
 * InMemoryKnowledgeBackend — a dependency-free reference implementation of
 * KnowledgeBackend backed by plain Maps.
 *
 * Purpose:
 *   1. Prove the KnowledgeBackend seam is actually implementable (not just types) —
 *      a working template for anyone writing a third-party backend.
 *   2. Serve as the test double for the cross-backend contract/parity tests.
 *   3. Give core a fast, deterministic backend for unit tests.
 *
 * It is NOT the shipped local store — that is LocalBackend over SQLite. It implements
 * the CRUD + tree + activity + refresh-queue slice faithfully; the context/intelligence
 * formulas are reference-only (derive from what's stored) and capabilities() reports a
 * pure-local, no-AI profile.
 */
import { randomUUID } from "node:crypto";
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
  SubtreeMemoryIndexResult,
  RouteIntentInput,
  RoutingResult,
} from "@pathrule/shared/routing-types.js";
import type { DedupCheckArgs, DedupCheckResult } from "@pathrule/shared/tools/dedup-types.js";
import type { MaterialisedNode } from "@pathrule/shared/tools/node-path.js";
import type { WorkspaceOverviewNode } from "@pathrule/shared/tools/overview.js";
import type {
  RefreshRow,
  RefreshBrief,
  RefreshStatus,
  PendingRefreshSummary,
  RequestRefreshResult,
} from "@pathrule/shared/tools/refresh-types.js";
import { pathsEqual, pathStartsWith } from "@pathrule/shared/path-compare.js";
import { normalizeNodePath, guessLeafType } from "@pathrule/shared/tools/node-path.js";
import { buildWorkspaceOverview } from "@pathrule/shared/tools/overview.js";
import { runAiRouteAdapter, hasAiRouteKey } from "./ai-route-adapter.js";
import { rankProjectMap, type ProjectMapCandidate } from "./project-map-rank.js";
import { activityTouchedPaths, rankCoupledPaths } from "./co-change-rank.js";
import { searchEpisodes, clusterEpisodes, type EpisodeActivity } from "./work-episodes.js";
import { assembleBriefingLocal } from "./briefing.js";
import { assembleHookIndex, type HookRuleInput } from "./hook-index.js";
import { embedTextBYO, hasEmbeddingKey, type EmbedFn } from "./embedding-adapter.js";
import {
  cosineSimilarity,
  composeEmbeddingText,
  collectLexicalIds,
  shapeLocalSemanticCandidates,
  type ScoredCandidate,
  SEMANTIC_SCAN_TOP_K,
  SEMANTIC_QUERY_MIN_SIMILARITY,
} from "./semantic-rank.js";
import type { BackendCapabilities } from "./capabilities.js";
import type { KnowledgeBackend } from "./knowledge-backend.js";
import type {
  Activity,
  ActivityRecord,
  ContextScope,
  DeleteContentInput,
  DeleteContentResult,
  ListMemoriesQuery,
  ListRulesQuery,
  ListSkillsQuery,
  LogActivityInput,
  NodeDetailRecord,
  NodeRef,
  NodeContent,
  InvocationSkill,
  RelevantMemoryRow,
  RestoreContentResult,
  RequestRefreshInput,
  SemanticQuery,
  SemanticCandidatesResult,
  WorkspaceMatch,
  ClosestNode,
  UpdateMemoryInput,
  UpdateRuleInput,
  UpdateSkillInput,
  WriteMemoryInput,
  WriteRuleInput,
  WriteSkillInput,
} from "./inputs.js";

const DEFAULT_LOCAL_PRINCIPAL = "local";

/** Activity subjects → lowercase, trimmed, de-duped, capped at 5. */
export function normalizeActivitySubjects(subjects: string[] | undefined): string[] {
  return [...new Set((subjects ?? []).map((s) => s.toLowerCase().trim()).filter(Boolean))].slice(
    0,
    5,
  );
}

/**
 * The formula id stamped on locally-filed refreshes. The hosted edition uses concrete
 * formula ids driven by its staleness detector; local has no detector, so every flag
 * is a manual one.
 */
export const LOCAL_REFRESH_FORMULA = "manual_flag";

/** A refresh task owned by Local/InMemory before it is projected to RefreshRow/summary. */
export interface LocalRefreshEntry {
  id: string;
  workspaceId: string;
  subjectType: "memory" | "rule";
  subjectId: string;
  kind: string;
  reason: string;
  status: RefreshStatus;
  claimedByAi: string | null;
  claimedAt: string | null;
  resolvedAt: string | null;
  resolvedNote: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Subject snapshot resolved at read-time so the brief always reflects the current memory/rule. */
export interface RefreshSubjectSnapshot {
  title: string;
  body: string;
  nodePath: string;
}

/** Build the deterministic (no-LLM) brief Local/InMemory return — no proposedPatch. */
export function buildLocalRefreshBrief(
  entry: LocalRefreshEntry,
  subject: RefreshSubjectSnapshot,
): RefreshBrief {
  return {
    subject: {
      id: entry.subjectId,
      type: entry.subjectType,
      title: subject.title,
      nodePath: subject.nodePath,
      body: subject.body,
    },
    signal: {
      formulaId: LOCAL_REFRESH_FORMULA,
      humanReason: entry.reason,
      detectedAt: entry.createdAt,
      rawSignals: { kind: entry.kind },
    },
    aiInstructions:
      `Review this ${entry.subjectType} against the current code. Reason it was flagged: ${entry.reason} ` +
      `If stale, fix it with pathrule_update_${entry.subjectType} (pass refresh_id to auto-resolve); ` +
      `otherwise call pathrule_resolve_refresh with status='rejected'.`,
  };
}

/** Project a local entry + subject snapshot to the shared RefreshRow shape. */
export function localEntryToRefreshRow(
  entry: LocalRefreshEntry,
  subject: RefreshSubjectSnapshot,
): RefreshRow {
  return {
    id: entry.id,
    workspaceId: entry.workspaceId,
    suggestionId: null,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    formulaId: LOCAL_REFRESH_FORMULA,
    status: entry.status,
    requestedByUserId: "local",
    claimedByAi: entry.claimedByAi,
    claimedAt: entry.claimedAt,
    resolvedAt: entry.resolvedAt,
    resolvedNote: entry.resolvedNote,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    brief: buildLocalRefreshBrief(entry, subject),
  };
}

/** Project a local entry + subject snapshot to the pending-list summary. */
export function localEntryToSummary(
  entry: LocalRefreshEntry,
  subject: RefreshSubjectSnapshot,
): PendingRefreshSummary {
  return {
    id: entry.id,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    subjectTitle: subject.title,
    nodePath: subject.nodePath,
    formulaId: LOCAL_REFRESH_FORMULA,
    humanReason: entry.reason,
    status: entry.status,
    createdAt: entry.createdAt,
    hasProposedPatch: false,
  };
}

export interface InMemoryBackendOptions {
  /** Deterministic id generator (tests inject a counter); defaults to randomUUID. */
  genId?: () => string;
  /** Clock (tests inject a fixed value); defaults to wall clock ISO string. */
  now?: () => string;
  /** Identity stamped on created_by/last_edited_by. Defaults to "local" (reference store). */
  principal?: string;
  /** Injectable embedding seam (tests pass a deterministic stub). */
  embed?: EmbedFn;
}

export class InMemoryKnowledgeBackend implements KnowledgeBackend {
  private readonly memories = new Map<string, Memory>();
  private readonly rules = new Map<string, Rule>();
  private readonly skills = new Map<string, Skill>();
  private readonly nodes = new Map<string, TreeNode>();
  /** rule/skill → node attachment (the reference model of rule/skill node links). */
  private readonly ruleNodes = new Map<string, string>();
  private readonly skillNodes = new Map<string, string>();
  /** Soft-delete (archived) membership — mirrors LocalBackend's status='archived'. */
  private readonly archivedMemories = new Set<string>();
  private readonly archivedRules = new Set<string>();
  private readonly archivedSkills = new Set<string>();
  private readonly activities: Activity[] = [];
  /** Router/briefing projection (snake_case + files_touched) — the `recentActivitiesForRouter` source. */
  private readonly routerActivities: RecentActivityForRouter[] = [];
  /** Per-activity episode source (subjects + touched paths) — co-change + work-episode substrate. */
  private readonly episodeActivities: EpisodeActivity[] = [];
  /** memory id → context paths (the reference model of per-memory context links). */
  private readonly memoryContextPaths = new Map<string, Set<string>>();
  private readonly refreshes = new Map<string, LocalRefreshEntry>();
  /** memory id → stored embedding (the reference model of memory embeddings). */
  private readonly embeddings = new Map<
    string,
    { model: string; dims: number; vector: number[] }
  >();
  /** workspaceId → local root path (the reference model of a workspace's local root). */
  private readonly workspaceRoots = new Map<string, string>();
  private readonly genId: () => string;
  private readonly now: () => string;
  private readonly principal: string;
  private readonly embed: EmbedFn;
  private readonly semanticEnabled: boolean;

  constructor(options: InMemoryBackendOptions = {}) {
    this.genId = options.genId ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.principal = options.principal ?? DEFAULT_LOCAL_PRINCIPAL;
    this.embed = options.embed ?? ((text, opts) => embedTextBYO(text, opts));
    this.semanticEnabled = options.embed !== undefined || hasEmbeddingKey();
  }

  /** Best-effort embed + store for one memory; no-op when semantic is unwired. */
  private async embedAndStore(memoryId: string, title: string, content: string): Promise<void> {
    if (!this.semanticEnabled) return;
    try {
      const result = await this.embed(composeEmbeddingText(title, content), {
        inputType: "document",
      });
      if (!result) return;
      this.embeddings.set(memoryId, {
        model: result.model,
        dims: result.dims,
        vector: result.embedding,
      });
    } catch {
      // Best-effort: a failed embedding never fails the memory write.
    }
  }

  sessionIsCurrent(): Promise<boolean> {
    return Promise.resolve(true);
  }

  // ── workspace resolution ──────────────────────────────────────────────────
  /** Register a workspace root (reference seed; mirrors LocalBackend.registerWorkspace). */
  registerWorkspace(input: { workspaceId: string; name?: string; localRootPath: string }): void {
    this.workspaceRoots.set(input.workspaceId, input.localRootPath.replace(/\/+$/, ""));
  }

  resolveWorkspaceFromCwd(cwd: string): Promise<WorkspaceMatch | null> {
    const normalizedCwd = cwd.replace(/\/+$/, "");
    const best = [...this.workspaceRoots.entries()]
      .map(([wid, root]) => ({ wid, root }))
      .filter((r) => pathsEqual(normalizedCwd, r.root) || pathStartsWith(normalizedCwd, r.root))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (!best) return Promise.resolve(null);
    const relativePath = pathsEqual(normalizedCwd, best.root)
      ? ""
      : normalizedCwd.slice(best.root.length);
    return Promise.resolve({ workspaceId: best.wid, localRootPath: best.root, relativePath });
  }

  closestNode(workspaceId: string, relativePath: string): Promise<ClosestNode | null> {
    const candidates: string[] = [];
    let cur = relativePath;
    while (cur.length > 0) {
      candidates.push(cur);
      const idx = cur.lastIndexOf("/");
      if (idx <= 0) break;
      cur = cur.slice(0, idx);
    }
    candidates.push("");
    const byPath = new Map<string, string>();
    for (const node of this.nodes.values()) {
      if (node.workspaceId === workspaceId) byPath.set(node.relativePath, node.id);
    }
    for (const candidate of candidates) {
      const id = byPath.get(candidate);
      if (id) return Promise.resolve({ id, relativePath: candidate });
    }
    return Promise.resolve(null);
  }

  // ── memory CRUD ──────────────────────────────────────────────────────────
  readMemory(id: string): Promise<Memory | null> {
    if (this.archivedMemories.has(id)) return Promise.resolve(null);
    return Promise.resolve(this.memories.get(id) ?? null);
  }

  async writeMemory(input: WriteMemoryInput): Promise<Memory> {
    const ts = this.now();
    const memory: Memory = {
      id: this.genId(),
      workspaceId: input.workspaceId,
      nodeId: input.nodeId ?? "",
      title: input.title,
      content: input.content,
      source: input.source ?? "claude",
      versionId: this.genId(),
      versionNumber: 1,
      createdBy: this.principal,
      lastEditedBy: this.principal,
      lastEditedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };
    this.memories.set(memory.id, memory);
    await this.embedAndStore(memory.id, memory.title, memory.content);
    return memory;
  }

  async updateMemory(input: UpdateMemoryInput): Promise<Memory> {
    const existing = this.memories.get(input.id);
    if (!existing) throw new Error(`memory ${input.id} not found`);
    const ts = this.now();
    const next: Memory = {
      ...existing,
      title: input.title ?? existing.title,
      content: input.content ?? existing.content,
      nodeId: input.nodeId ?? existing.nodeId,
      versionId: this.genId(),
      versionNumber: existing.versionNumber + 1,
      lastEditedBy: this.principal,
      lastEditedAt: ts,
      updatedAt: ts,
    };
    this.memories.set(next.id, next);
    await this.embedAndStore(next.id, next.title, next.content);
    return next;
  }

  deleteMemory(input: DeleteContentInput): Promise<DeleteContentResult> {
    const existing = this.memories.get(input.id);
    if (!existing || this.archivedMemories.has(input.id)) {
      return Promise.resolve({ status: "rejected", reason: "not_found" });
    }
    if (input.expectedVersionId && existing.versionId !== input.expectedVersionId) {
      return Promise.resolve({ status: "conflict", currentVersionId: existing.versionId });
    }
    // Soft delete archives (restorable); hard delete purges — mirrors LocalBackend.
    if (input.hard) {
      this.memories.delete(input.id);
      this.embeddings.delete(input.id);
    } else {
      this.archivedMemories.add(input.id);
    }
    return Promise.resolve({
      status: "deleted",
      id: existing.id,
      workspaceId: existing.workspaceId,
      nodeId: existing.nodeId,
    });
  }

  restoreMemory(id: string): Promise<RestoreContentResult> {
    const existing = this.memories.get(id);
    if (!existing) return Promise.resolve({ status: "rejected", reason: "not_found" });
    if (!this.archivedMemories.has(id)) {
      return Promise.resolve({ status: "rejected", reason: "not_deleted" });
    }
    this.archivedMemories.delete(id);
    return Promise.resolve({
      status: "restored",
      id: existing.id,
      workspaceId: existing.workspaceId,
      nodeId: existing.nodeId,
    });
  }

  listMemories(query: ListMemoriesQuery): Promise<Memory[]> {
    const wantArchived = query.status === "archived";
    const rows = [...this.memories.values()]
      .filter(
        (m) =>
          m.workspaceId === query.workspaceId &&
          this.archivedMemories.has(m.id) === wantArchived &&
          (query.nodeId === undefined || m.nodeId === query.nodeId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return Promise.resolve(rows);
  }

  // ── rule CRUD ──────────────────────────────────────────────────────────────
  readRule(id: string): Promise<Rule | null> {
    if (this.archivedRules.has(id)) return Promise.resolve(null);
    return Promise.resolve(this.rules.get(id) ?? null);
  }

  writeRule(input: WriteRuleInput): Promise<Rule> {
    const ts = this.now();
    const rule: Rule = {
      id: this.genId(),
      workspaceId: input.workspaceId,
      name: input.name,
      content: input.content,
      scopeType: input.scopeType,
      priority: input.priority ?? "medium",
      versionId: this.genId(),
      versionNumber: 1,
      createdBy: this.principal,
      lastEditedBy: this.principal,
      lastEditedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    };
    this.rules.set(rule.id, rule);
    if (input.nodeId) this.ruleNodes.set(rule.id, input.nodeId);
    return Promise.resolve(rule);
  }

  updateRule(input: UpdateRuleInput): Promise<Rule> {
    const existing = this.rules.get(input.id);
    if (!existing) throw new Error(`rule ${input.id} not found`);
    const ts = this.now();
    const next: Rule = {
      ...existing,
      name: input.name ?? existing.name,
      content: input.content ?? existing.content,
      scopeType: input.scopeType ?? existing.scopeType,
      priority: input.priority ?? existing.priority,
      versionId: this.genId(),
      versionNumber: existing.versionNumber + 1,
      lastEditedBy: this.principal,
      lastEditedAt: ts,
      updatedAt: ts,
    };
    this.rules.set(next.id, next);
    if (input.nodeId) this.ruleNodes.set(next.id, input.nodeId);
    return Promise.resolve(next);
  }

  deleteRule(input: DeleteContentInput): Promise<DeleteContentResult> {
    const existing = this.rules.get(input.id);
    if (!existing || this.archivedRules.has(input.id)) {
      return Promise.resolve({ status: "rejected", reason: "not_found" });
    }
    if (input.expectedVersionId && existing.versionId !== input.expectedVersionId) {
      return Promise.resolve({ status: "conflict", currentVersionId: existing.versionId });
    }
    if (input.hard) {
      this.rules.delete(input.id);
      this.ruleNodes.delete(input.id);
    } else {
      this.archivedRules.add(input.id); // keep the node attachment for restore
    }
    return Promise.resolve({
      status: "deleted",
      id: existing.id,
      workspaceId: existing.workspaceId,
      nodeId: null,
    });
  }

  restoreRule(id: string): Promise<RestoreContentResult> {
    const existing = this.rules.get(id);
    if (!existing) return Promise.resolve({ status: "rejected", reason: "not_found" });
    if (!this.archivedRules.has(id)) {
      return Promise.resolve({ status: "rejected", reason: "not_deleted" });
    }
    this.archivedRules.delete(id);
    return Promise.resolve({
      status: "restored",
      id: existing.id,
      workspaceId: existing.workspaceId,
      nodeId: null,
    });
  }

  listRules(query: ListRulesQuery): Promise<Rule[]> {
    const wantArchived = query.status === "archived";
    return Promise.resolve(
      [...this.rules.values()].filter(
        (r) => r.workspaceId === query.workspaceId && this.archivedRules.has(r.id) === wantArchived,
      ),
    );
  }

  // ── skill CRUD ───────────────────────────────────────────────────────────────
  readSkill(id: string): Promise<Skill | null> {
    if (this.archivedSkills.has(id)) return Promise.resolve(null);
    return Promise.resolve(this.skills.get(id) ?? null);
  }

  writeSkill(input: WriteSkillInput): Promise<Skill> {
    const ts = this.now();
    const source = input.source ?? "manual";
    const skill: Skill = {
      id: this.genId(),
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description ?? null,
      content: input.content,
      source,
      githubUrl: input.githubUrl ?? null,
      version: "1.0.0",
      tags: input.tags ?? [],
      versionId: this.genId(),
      versionNumber: 1,
      createdBy: this.principal,
      lastEditedBy: this.principal,
      lastEditedAt: ts,
      createdAt: ts,
      updatedAt: ts,
      contentFetchedAt: source === "github_ref" ? ts : null,
    };
    this.skills.set(skill.id, skill);
    if (input.nodeId) this.skillNodes.set(skill.id, input.nodeId);
    return Promise.resolve(skill);
  }

  updateSkill(input: UpdateSkillInput): Promise<Skill> {
    const existing = this.skills.get(input.id);
    if (!existing) throw new Error(`skill ${input.id} not found`);
    const ts = this.now();
    const effectiveSource = input.source ?? existing.source;
    const next: Skill = {
      ...existing,
      name: input.name ?? existing.name,
      content: input.content ?? existing.content,
      description: input.description !== undefined ? input.description : existing.description,
      source: effectiveSource,
      githubUrl: input.githubUrl !== undefined ? input.githubUrl : existing.githubUrl,
      tags: input.tags ?? existing.tags,
      contentFetchedAt:
        input.content !== undefined && effectiveSource === "github_ref"
          ? ts
          : existing.contentFetchedAt,
      versionId: this.genId(),
      versionNumber: existing.versionNumber + 1,
      lastEditedBy: this.principal,
      lastEditedAt: ts,
      updatedAt: ts,
    };
    this.skills.set(next.id, next);
    if (input.nodeId) this.skillNodes.set(next.id, input.nodeId);
    return Promise.resolve(next);
  }

  deleteSkill(input: DeleteContentInput): Promise<DeleteContentResult> {
    const existing = this.skills.get(input.id);
    if (!existing || this.archivedSkills.has(input.id)) {
      return Promise.resolve({ status: "rejected", reason: "not_found" });
    }
    if (input.expectedVersionId && existing.versionId !== input.expectedVersionId) {
      return Promise.resolve({ status: "conflict", currentVersionId: existing.versionId });
    }
    if (input.hard) {
      this.skills.delete(input.id);
      this.skillNodes.delete(input.id);
    } else {
      this.archivedSkills.add(input.id); // keep the node attachment for restore
    }
    return Promise.resolve({
      status: "deleted",
      id: existing.id,
      workspaceId: existing.workspaceId,
      nodeId: null,
    });
  }

  restoreSkill(id: string): Promise<RestoreContentResult> {
    const existing = this.skills.get(id);
    if (!existing) return Promise.resolve({ status: "rejected", reason: "not_found" });
    if (!this.archivedSkills.has(id)) {
      return Promise.resolve({ status: "rejected", reason: "not_deleted" });
    }
    this.archivedSkills.delete(id);
    return Promise.resolve({
      status: "restored",
      id: existing.id,
      workspaceId: existing.workspaceId,
      nodeId: null,
    });
  }

  listSkills(query: ListSkillsQuery): Promise<Skill[]> {
    const wantArchived = query.status === "archived";
    return Promise.resolve(
      [...this.skills.values()].filter(
        (s) =>
          s.workspaceId === query.workspaceId && this.archivedSkills.has(s.id) === wantArchived,
      ),
    );
  }

  // ── tree ─────────────────────────────────────────────────────────────────────
  getTree(workspaceId: string): Promise<TreeNode[]> {
    return Promise.resolve([...this.nodes.values()].filter((n) => n.workspaceId === workspaceId));
  }

  getNode(nodeId: string): Promise<TreeNode | null> {
    return Promise.resolve(this.nodes.get(nodeId) ?? null);
  }

  getNodeDetail(nodeId: string): Promise<NodeDetailRecord | null> {
    const node = this.nodes.get(nodeId);
    if (!node) return Promise.resolve(null);
    const memoryIds = [...this.memories.values()]
      .filter((m) => m.nodeId === nodeId && !this.archivedMemories.has(m.id))
      .map((m) => m.id);
    const ruleIds = [...this.ruleNodes.entries()]
      .filter(([rid, nid]) => nid === nodeId && !this.archivedRules.has(rid))
      .map(([rid]) => rid);
    const skillIds = [...this.skillNodes.entries()]
      .filter(([sid, nid]) => nid === nodeId && !this.archivedSkills.has(sid))
      .map(([sid]) => sid);
    return Promise.resolve({
      id: node.id,
      workspaceId: node.workspaceId,
      parentId: node.parentId,
      name: node.name,
      type: node.type,
      relativePath: node.relativePath,
      memoryIds,
      ruleIds,
      skillIds,
    });
  }

  workspaceOverview(workspaceId: string, excludeNodeId?: string): Promise<WorkspaceOverviewNode[]> {
    const nodes = [...this.nodes.values()]
      .filter((n) => n.workspaceId === workspaceId)
      .map((n) => ({ id: n.id, relativePath: n.relativePath }));
    const memories = [...this.memories.values()]
      .filter((m) => m.workspaceId === workspaceId && !this.archivedMemories.has(m.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((m) => ({ id: m.id, title: m.title, nodeId: m.nodeId }));
    const rules = [...this.ruleNodes.entries()]
      .filter(([rid]) => !this.archivedRules.has(rid))
      .map(([rid, nodeId]) => ({ rid, nodeId, rule: this.rules.get(rid) }))
      .filter((x) => x.rule && x.rule.workspaceId === workspaceId)
      .map(({ rid, nodeId, rule }) => ({
        nodeId,
        id: rid,
        name: rule!.name,
        content: rule!.content,
        scopeType: rule!.scopeType,
        priority: rule!.priority,
      }));
    const skills = [...this.skillNodes.entries()]
      .filter(([sid]) => !this.archivedSkills.has(sid))
      .map(([sid, nodeId]) => ({ sid, nodeId, skill: this.skills.get(sid) }))
      .filter((x) => x.skill && x.skill.workspaceId === workspaceId)
      .map(({ sid, nodeId, skill }) => ({
        nodeId,
        id: sid,
        name: skill!.name,
        description: skill!.description,
        source: skill!.source,
        tags: skill!.tags,
      }));
    return Promise.resolve(
      buildWorkspaceOverview({ nodes, memories, rules, skills, excludeNodeId }),
    );
  }

  findNodeByPath(workspaceId: string, relativePath: string): Promise<NodeRef | null> {
    const node = [...this.nodes.values()].find(
      (n) => n.workspaceId === workspaceId && n.relativePath === relativePath,
    );
    return Promise.resolve(
      node ? { id: node.id, name: node.name, relativePath: node.relativePath } : null,
    );
  }

  getNodeContent(nodeId: string): Promise<NodeContent> {
    const memories = [...this.memories.values()]
      .filter((m) => m.nodeId === nodeId && !this.archivedMemories.has(m.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((m) => ({ id: m.id, title: m.title, content: m.content }));
    const rules = [...this.ruleNodes.entries()]
      .filter(([rid, nid]) => nid === nodeId && !this.archivedRules.has(rid))
      .map(([rid]) => this.rules.get(rid))
      .filter((r): r is Rule => Boolean(r))
      .map((r) => ({
        id: r.id,
        name: r.name,
        content: r.content,
        scopeType: r.scopeType,
        priority: r.priority,
      }));
    const skills = [...this.skillNodes.entries()]
      .filter(([sid, nid]) => nid === nodeId && !this.archivedSkills.has(sid))
      .map(([sid]) => this.skills.get(sid))
      .filter((s): s is Skill => Boolean(s))
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        source: s.source,
        tags: s.tags,
      }));
    return Promise.resolve({ memories, rules, skills });
  }

  listSkillsForInvocation(workspaceId: string): Promise<InvocationSkill[]> {
    return Promise.resolve(
      [...this.skills.values()]
        .filter((s) => s.workspaceId === workspaceId && !this.archivedSkills.has(s.id))
        .map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          content: s.content,
          source: s.source,
          githubUrl: s.githubUrl,
        })),
    );
  }

  getNodeForRule(ruleId: string): Promise<TreeNode | null> {
    const nodeId = this.ruleNodes.get(ruleId);
    return Promise.resolve((nodeId && this.nodes.get(nodeId)) || null);
  }

  getNodeForSkill(skillId: string): Promise<TreeNode | null> {
    const nodeId = this.skillNodes.get(skillId);
    return Promise.resolve((nodeId && this.nodes.get(nodeId)) || null);
  }

  private nodeByPath(workspaceId: string, relativePath: string): TreeNode | undefined {
    return [...this.nodes.values()].find(
      (n) => n.workspaceId === workspaceId && n.relativePath === relativePath,
    );
  }

  private materialise(node: TreeNode): MaterialisedNode {
    return {
      id: node.id,
      workspace_id: node.workspaceId,
      parent_id: node.parentId,
      name: node.name,
      type: node.type,
      relative_path: node.relativePath,
    };
  }

  ensureNodeForPath(
    workspaceId: string,
    path: string,
    leafType?: MaterialisedNode["type"],
  ): Promise<MaterialisedNode> {
    const relativePath = normalizeNodePath(path);
    const create = (
      parentId: string | null,
      name: string,
      type: TreeNode["type"],
      rel: string,
      orderIndex: number,
    ): TreeNode => {
      const ts = this.now();
      const node: TreeNode = {
        id: this.genId(),
        workspaceId,
        parentId,
        name,
        type,
        relativePath: rel,
        orderIndex,
        status: "active",
        orphanedAt: null,
        originalPath: null,
        createdAt: ts,
        updatedAt: ts,
      };
      this.nodes.set(node.id, node);
      return node;
    };

    let root = this.nodeByPath(workspaceId, "/");
    if (!root) root = create(null, "Workspace", "folder", "/", 0);
    if (relativePath === "/") return Promise.resolve(this.materialise(root));

    const existing = this.nodeByPath(workspaceId, relativePath);
    if (existing) return Promise.resolve(this.materialise(existing));

    const segments = relativePath.split("/").filter((s) => s.length > 0);
    const resolvedLeafType = leafType ?? guessLeafType(relativePath);
    let parent = root;
    let cumulative = "";
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!;
      cumulative += "/" + seg;
      const here = this.nodeByPath(workspaceId, cumulative);
      if (here) {
        parent = here;
        continue;
      }
      const siblings = [...this.nodes.values()].filter(
        (n) => n.workspaceId === workspaceId && n.parentId === parent.id,
      ).length;
      const type = i === segments.length - 1 ? resolvedLeafType : "folder";
      parent = create(parent.id, seg, type, cumulative, siblings);
    }
    return Promise.resolve(this.materialise(parent));
  }

  // ── write guards / dedup ─────────────────────────────────────────────────
  isDemoWorkspace(_workspaceId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  checkContentDedup(args: DedupCheckArgs): Promise<DedupCheckResult> {
    const norm = args.candidate.trim().toLowerCase();
    const eq = (s: string) => s.trim().toLowerCase() === norm;
    let dup: { id: string; title: string } | null = null;
    if (args.kind === "memory") {
      const m = [...this.memories.values()].find(
        (x) =>
          x.workspaceId === args.workspaceId &&
          x.nodeId === (args.nodeId ?? "") &&
          eq(x.title) &&
          x.id !== args.excludeId,
      );
      if (m) dup = { id: m.id, title: m.title };
    } else if (args.kind === "rule") {
      const r = [...this.rules.values()].find(
        (x) => x.workspaceId === args.workspaceId && eq(x.name) && x.id !== args.excludeId,
      );
      if (r) dup = { id: r.id, title: r.name };
    } else {
      const s = [...this.skills.values()].find(
        (x) => x.workspaceId === args.workspaceId && eq(x.name) && x.id !== args.excludeId,
      );
      if (s) dup = { id: s.id, title: s.name };
    }
    return Promise.resolve({ duplicate: dup, similar: [] });
  }

  // ── context formulas (reference-only over stored rows) ─────────────────────────
  subtreeMemoryIndex(scope: ContextScope, limit: number): Promise<SubtreeMemoryIndexResult> {
    const root = scope.relativePath || "/";
    const inSubtree = (p: string) => root === "/" || p === root || p.startsWith(`${root}/`);
    const all = [...this.memories.values()]
      .filter((m) => m.workspaceId === scope.workspaceId && !this.archivedMemories.has(m.id))
      .map((m) => ({ m, node: m.nodeId ? this.nodes.get(m.nodeId) : undefined }))
      .filter(
        (x): x is { m: Memory; node: TreeNode } =>
          Boolean(x.node) && inSubtree(x.node!.relativePath),
      )
      .sort((a, b) => a.m.createdAt.localeCompare(b.m.createdAt));
    const entries = all
      .slice(0, limit)
      .map(({ m, node }) => ({ id: m.id, title: m.title, node_path: node.relativePath }));
    return Promise.resolve({ entries, truncated: all.length > entries.length, total: all.length });
  }

  projectMapSearch(
    workspaceId: string,
    query: string,
    limit = 15,
  ): Promise<ProjectMapSearchResult> {
    if (!query || query.trim().length === 0) {
      return Promise.resolve({ nodes: [], topScore: 0 });
    }
    const candidates: ProjectMapCandidate[] = [];
    for (const node of this.nodes.values()) {
      if (node.workspaceId !== workspaceId) continue;
      const memories = [...this.memories.values()].filter(
        (m) => m.nodeId === node.id && !this.archivedMemories.has(m.id),
      );
      const ruleIds = [...this.ruleNodes.entries()]
        .filter(([rid, nid]) => nid === node.id && !this.archivedRules.has(rid))
        .map(([rid]) => rid);
      const skillIds = [...this.skillNodes.entries()]
        .filter(([sid, nid]) => nid === node.id && !this.archivedSkills.has(sid))
        .map(([sid]) => sid);
      const rules = ruleIds.map((id) => this.rules.get(id)).filter((r): r is Rule => Boolean(r));
      const skills = skillIds
        .map((id) => this.skills.get(id))
        .filter((s): s is Skill => Boolean(s));
      if (memories.length === 0 && rules.length === 0 && skills.length === 0) continue;
      const bodyPreview = [
        ...memories.map((m) => m.content ?? ""),
        ...rules.map((r) => r.content ?? ""),
        ...skills.map((s) => s.content ?? ""),
      ]
        .join(" ")
        .slice(0, 400);
      candidates.push({
        node_id: node.id,
        path: node.relativePath,
        name: node.name,
        memory_titles: memories.map((m) => m.title),
        rule_names: rules.map((r) => r.name),
        skill_names: skills.map((s) => s.name),
        body_preview: bodyPreview,
      });
    }
    return Promise.resolve(rankProjectMap(candidates, query, limit));
  }

  // Hot paths derived from the in-memory activity feed (top-5 node_paths by count
  // over the last 7 days), mirroring LocalBackend's activity_logs derivation.
  getHotPaths(workspaceId: string): Promise<HotPath[]> {
    void workspaceId; // single-workspace reference store; activities aren't ws-partitioned
    const since = Date.parse(this.now()) - 7 * 24 * 60 * 60 * 1000;
    const counts = new Map<string, number>();
    for (const a of this.activities) {
      const path = a.nodePath;
      if (!path) continue;
      if (Date.parse(a.createdAt) < since) continue;
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
    const hot = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([path, change_count]) => ({ path, change_count }));
    return Promise.resolve(hot);
  }

  // Snapshot recent activity paths (last 30 min) onto the memory.
  recordMemoryContextPaths(memoryId: string, workspaceId: string): Promise<void> {
    void workspaceId; // single-workspace reference store
    const since = Date.parse(this.now()) - 30 * 60 * 1000;
    const paths = new Set<string>();
    for (const a of this.activities) {
      if (!a.nodePath) continue;
      if (Date.parse(a.createdAt) < since) continue;
      paths.add(a.nodePath);
    }
    if (paths.size === 0) return Promise.resolve();
    const existing = this.memoryContextPaths.get(memoryId) ?? new Set<string>();
    for (const p of paths) existing.add(p);
    this.memoryContextPaths.set(memoryId, existing);
    return Promise.resolve();
  }

  // Memories whose context paths overlap matchedPaths, newest first.
  rankPriorSolutions(
    workspaceId: string,
    matchedPaths: string[],
    limit = 5,
  ): Promise<PriorSolution[]> {
    if (!matchedPaths || matchedPaths.length === 0) return Promise.resolve([]);
    const effectiveLimit = limit > 0 ? limit : 5;
    const matched = new Set(matchedPaths);
    const hits: PriorSolution[] = [];
    for (const [memoryId, paths] of this.memoryContextPaths) {
      const overlap = [...paths].filter((p) => matched.has(p));
      if (overlap.length === 0) continue;
      const m = this.memories.get(memoryId);
      if (!m || m.workspaceId !== workspaceId || this.archivedMemories.has(memoryId)) continue;
      hits.push({
        memory_id: m.id,
        title: m.title,
        preview: (m.content ?? "").slice(0, 200),
        related_paths: overlap,
        created_at: m.createdAt,
      });
    }
    hits.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return Promise.resolve(hits.slice(0, effectiveLimit));
  }

  // Co-change derived from the retained per-activity touched paths.
  findCoupledNodes(
    workspaceId: string,
    seedNodeIds: string[],
    seedPaths: string[],
    _changeLogCount: number,
  ): Promise<NodeBrief[]> {
    void _changeLogCount;
    const seedSet = new Set(seedPaths.filter(Boolean));
    for (const id of seedNodeIds) {
      const node = this.nodes.get(id);
      if (node && node.workspaceId === workspaceId) seedSet.add(node.relativePath);
    }
    if (seedSet.size === 0) return Promise.resolve([]);

    const coupled = rankCoupledPaths(
      this.episodeActivities.map((a) => a.touchedPaths),
      [...seedSet],
    );
    const briefs: NodeBrief[] = coupled.map((c) => {
      const node = this.nodeByPath(workspaceId, c.path);
      return {
        node_id: node?.id ?? "",
        path: c.path,
        name: node?.name ?? c.path.split("/").filter(Boolean).pop() ?? c.path,
        memory_titles: [],
        rule_names: [],
        skill_names: [],
        match_source: "co_change" as const,
        relevance: Math.min(1, c.weight / 10),
      };
    });
    return Promise.resolve(briefs);
  }

  // Local clusters on-read; refresh is a no-op (the hosted edition materializes a table).
  refreshWorkEpisodes(
    _workspaceId: string,
    _since?: string,
  ): Promise<{ ok: boolean; episodes_upserted: number }> {
    void _workspaceId;
    void _since;
    return Promise.resolve({ ok: true, episodes_upserted: 0 });
  }

  // Deterministic episode clustering over the retained activity source.
  searchWorkEpisodes(
    _workspaceId: string,
    query: string,
    _mode: "compact" | "deep",
    limit: number,
  ): Promise<WorkEpisodeBrief[]> {
    void _workspaceId;
    void _mode;
    return Promise.resolve(searchEpisodes(this.episodeActivities, query, limit));
  }

  // Compose the deep briefing from engine outputs + local prior_solutions.
  async assembleBriefing(input: AssembleBriefingInput): Promise<ResearchBriefing> {
    const primaryPaths =
      input.primaryPaths && input.primaryPaths.length > 0
        ? input.primaryPaths
        : input.primaryNodes.map((n) => n.path).filter(Boolean);
    const prior = await this.rankPriorSolutions(input.workspaceId, primaryPaths, 5);
    return assembleBriefingLocal(input, prior);
  }

  // Union: node-owner (node-at-path + ancestors) ∪ context-link memories.
  relevantMemoriesForPath(
    workspaceId: string,
    path: string,
    limit = 16,
  ): Promise<RelevantMemoryRow[]> {
    const isAncestorOwner = (rp: string): boolean =>
      path === rp || path.startsWith(`${rp}/`) || path === "/";
    const linkMatches = (mcp: string): boolean =>
      mcp === path ||
      (path !== "/" && path.startsWith(`${mcp}/`)) ||
      (path !== "/" && mcp.startsWith(`${path}/`)) ||
      path === "/";

    const rows: RelevantMemoryRow[] = [];
    const seen = new Set<string>();

    for (const m of this.memories.values()) {
      if (m.workspaceId !== workspaceId || this.archivedMemories.has(m.id)) continue;
      const node = m.nodeId ? this.nodes.get(m.nodeId) : undefined;
      if (!node || !isAncestorOwner(node.relativePath)) continue;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      rows.push({
        memory_id: m.id,
        node_id: m.nodeId,
        title: m.title,
        via: "node_owner",
        matched_path: null,
        confidence: 1.0,
      });
    }

    for (const [memoryId, paths] of this.memoryContextPaths) {
      if (seen.has(memoryId)) continue;
      const m = this.memories.get(memoryId);
      if (!m || m.workspaceId !== workspaceId || this.archivedMemories.has(memoryId)) continue;
      const matched = [...paths].find(linkMatches);
      if (!matched) continue;
      seen.add(memoryId);
      rows.push({
        memory_id: m.id,
        node_id: m.nodeId,
        title: m.title,
        via: "context_link",
        matched_path: matched,
        confidence: null,
      });
    }
    return Promise.resolve(rows.slice(0, limit));
  }

  // Assemble the offline HookIndex from the in-memory store.
  buildHookIndexPayload(workspaceId: string): Promise<HookIndex | null> {
    const memories = [...this.memories.values()]
      .filter((m) => m.workspaceId === workspaceId && !this.archivedMemories.has(m.id))
      .map((m) => {
        const node = m.nodeId ? this.nodes.get(m.nodeId) : undefined;
        return {
          id: m.id,
          title: m.title,
          content: m.content,
          node_path: node?.relativePath ?? "/",
          semantic_tags: null,
        };
      })
      .filter((m) => Boolean(m.node_path));

    const rules: HookRuleInput[] = [...this.rules.values()]
      .filter((r) => r.workspaceId === workspaceId && !this.archivedRules.has(r.id))
      .map((r) => {
        const nodeId = this.ruleNodes.get(r.id);
        const node = nodeId ? this.nodes.get(nodeId) : undefined;
        return {
          id: r.id,
          name: r.name,
          content: r.content,
          scope_type: r.scopeType,
          priority: r.priority,
          node_paths: node ? [node.relativePath] : [],
          semantic_tags: null,
        };
      });

    const skills = [...this.skills.values()]
      .filter((s) => s.workspaceId === workspaceId && !this.archivedSkills.has(s.id))
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        content: s.content,
        source: s.source,
        github_url: s.githubUrl,
        semantic_tags: null,
      }));

    const since = Date.parse(this.now()) - 30 * 60 * 1000;
    const recentActivitySubjects = [...this.episodeActivities].slice(-100).map((a) => a.subjects);
    const recentActivityDigest = this.activities
      .filter((a) => Date.parse(a.createdAt) >= since)
      .map((a) => ({
        domain: a.domain,
        action: a.action,
        node_path: a.nodePath,
        task_summary: a.taskSummary,
      }));

    const workEpisodes = clusterEpisodes(this.episodeActivities).filter(
      (e) => e.confidence === "medium" || e.confidence === "high",
    );

    let pendingRefreshCount = 0;
    let inProgressRefreshCount = 0;
    for (const e of this.refreshes.values()) {
      if (e.workspaceId !== workspaceId) continue;
      if (e.status === "pending") pendingRefreshCount += 1;
      else if (e.status === "in_progress") inProgressRefreshCount += 1;
    }

    return Promise.resolve(
      assembleHookIndex({
        workspaceId,
        generatedAt: this.now(),
        memories,
        rules,
        skills,
        recentActivitySubjects,
        recentActivityDigest,
        workEpisodes,
        pendingRefreshCount,
        inProgressRefreshCount,
      }),
    );
  }

  // ── activity ───────────────────────────────────────────────────────────────────
  logActivity(input: LogActivityInput): Promise<ActivityRecord> {
    const subjects = normalizeActivitySubjects(input.subjects);
    const record: ActivityRecord = {
      id: this.genId(),
      workspaceId: input.workspaceId,
      nodePath: input.nodePath || "/",
      domain: input.domain,
      action: input.action,
      scope: input.scope,
      subjects,
      taskSummary: input.taskSummary,
      filesTouched: input.filesTouched ?? { total: 0, by_area: {} },
      aiClient: input.aiClient ?? "claude-code",
      detailLevel: "standard",
      status: "active",
      createdAt: this.now(),
    };
    // Friction + applied-memory signals are hosted-only — intentionally dropped here.
    this.activities.push({
      id: record.id,
      nodePath: record.nodePath,
      domain: record.domain,
      action: record.action,
      taskSummary: record.taskSummary,
      createdAt: record.createdAt,
    });
    // Router/briefing projection — keeps files_touched (the lean Activity drops it).
    this.routerActivities.push({
      domain: record.domain,
      action: record.action,
      task_summary: record.taskSummary,
      created_at: record.createdAt,
      node_path: record.nodePath,
      files_touched: record.filesTouched,
    });
    // Retain the episode source (subjects + touched paths) — neither is on the Activity type.
    this.episodeActivities.push({
      id: record.id,
      createdAt: record.createdAt,
      domain: record.domain,
      subjects: record.subjects,
      touchedPaths: activityTouchedPaths(record.filesTouched.by_area, record.nodePath),
      taskSummary: record.taskSummary,
    });
    return Promise.resolve(record);
  }

  recentActivities(_scope: ContextScope, limit: number): Promise<Activity[]> {
    return Promise.resolve(this.activities.slice(-limit).reverse());
  }

  // Router/briefing recent-activity shape. Single principal, so the userId
  // filter is ignored (mirrors LocalBackend).
  recentActivitiesForRouter(
    _workspaceId: string,
    limit: number,
    _userId?: string | null,
  ): Promise<RecentActivityForRouter[]> {
    return Promise.resolve(this.routerActivities.slice(-limit).reverse());
  }

  // ── refresh queue ────────────────────────────────────────────────────────────────
  private subjectSnapshot(
    subjectType: "memory" | "rule",
    subjectId: string,
  ): RefreshSubjectSnapshot {
    if (subjectType === "memory") {
      const m = this.memories.get(subjectId);
      const node = m?.nodeId ? this.nodes.get(m.nodeId) : undefined;
      return {
        title: m?.title ?? "(unknown)",
        body: m?.content ?? "",
        nodePath: node?.relativePath ?? "/",
      };
    }
    const r = this.rules.get(subjectId);
    const nodeId = this.ruleNodes.get(subjectId);
    const node = nodeId ? this.nodes.get(nodeId) : undefined;
    return {
      title: r?.name ?? "(unknown)",
      body: r?.content ?? "",
      nodePath: node?.relativePath ?? "/",
    };
  }

  listPendingRefreshes(
    workspaceId: string,
    includeInProgress?: boolean,
  ): Promise<PendingRefreshSummary[]> {
    const open: RefreshStatus[] = includeInProgress ? ["pending", "in_progress"] : ["pending"];
    const rows = [...this.refreshes.values()]
      .filter((t) => t.workspaceId === workspaceId && open.includes(t.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => localEntryToSummary(t, this.subjectSnapshot(t.subjectType, t.subjectId)));
    return Promise.resolve(rows);
  }

  getRefreshBrief(refreshId: string, claimedBy?: string): Promise<RefreshRow> {
    const entry = this.refreshes.get(refreshId);
    if (!entry) throw new Error(`refresh ${refreshId} not found`);
    // Claim-on-read: pending → in_progress.
    if (entry.status === "pending") {
      entry.status = "in_progress";
      entry.claimedAt = this.now();
      entry.claimedByAi = claimedBy ?? null;
      entry.updatedAt = entry.claimedAt;
    }
    return Promise.resolve(
      localEntryToRefreshRow(entry, this.subjectSnapshot(entry.subjectType, entry.subjectId)),
    );
  }

  resolveRefresh(
    refreshId: string,
    status: "applied" | "rejected",
    note?: string,
    claimedBy?: string,
  ): Promise<RefreshRow> {
    const entry = this.refreshes.get(refreshId);
    if (!entry) throw new Error(`refresh ${refreshId} not found`);
    entry.status = status;
    entry.resolvedAt = this.now();
    entry.resolvedNote = note ?? null;
    if (claimedBy) entry.claimedByAi = claimedBy;
    entry.updatedAt = entry.resolvedAt;
    // No suggestion mirror / dismissal window / notifications — those are hosted-only curation.
    return Promise.resolve(
      localEntryToRefreshRow(entry, this.subjectSnapshot(entry.subjectType, entry.subjectId)),
    );
  }

  requestRefresh(input: RequestRefreshInput): Promise<RequestRefreshResult> {
    const subjectWs =
      input.subjectType === "memory"
        ? this.memories.get(input.subjectId)?.workspaceId
        : this.rules.get(input.subjectId)?.workspaceId;
    if (!subjectWs) throw new Error(`refresh subject ${input.subjectId} not found`);
    // Idempotent per open subject: an existing pending/in_progress task wins.
    const existing = [...this.refreshes.values()].find(
      (t) =>
        t.subjectId === input.subjectId && (t.status === "pending" || t.status === "in_progress"),
    );
    if (existing) return Promise.resolve({ refreshId: existing.id, alreadyPending: true });
    const ts = this.now();
    const entry: LocalRefreshEntry = {
      id: this.genId(),
      workspaceId: subjectWs,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: input.kind ?? "drift",
      reason: input.reason,
      status: "pending",
      claimedByAi: null,
      claimedAt: null,
      resolvedAt: null,
      resolvedNote: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.refreshes.set(entry.id, entry);
    return Promise.resolve({ refreshId: entry.id, alreadyPending: false });
  }

  // Bring-your-own ai-route. Delegates to the shared pure adapter: returns
  // null when no PATHRULE_AI_ROUTE_KEY is set (deterministic fallback upstream).
  async routeIntent(input: RouteIntentInput): Promise<RoutingResult | null> {
    return runAiRouteAdapter(input);
  }

  // Reference semantic search over the in-memory embedding map. Mirrors
  // LocalBackend.semanticCandidates exactly (same shaper, same skip contract)
  // so the parity suite proves the two stay shape-identical.
  async semanticCandidates(query: SemanticQuery): Promise<SemanticCandidatesResult | null> {
    if (!this.semanticEnabled) return null;
    const start = Date.now();
    const intent = query.userIntent.trim();
    if (intent.length === 0) return { payload: undefined, skipped: "empty_intent" };

    let queryEmbedding: { embedding: number[]; model: string; dims: number } | null;
    try {
      queryEmbedding = await this.embed(intent, { inputType: "query" });
    } catch {
      return { payload: undefined, skipped: "provider_failure", latencyMs: Date.now() - start };
    }
    if (!queryEmbedding) return null;

    const limit = query.limit ?? SEMANTIC_SCAN_TOP_K;
    const minSimilarity = query.minSimilarity ?? SEMANTIC_QUERY_MIN_SIMILARITY;

    const scored: ScoredCandidate[] = [];
    for (const [memoryId, stored] of this.embeddings) {
      if (stored.dims !== queryEmbedding.dims) continue;
      const memory = this.memories.get(memoryId);
      if (!memory || memory.workspaceId !== query.workspaceId) continue;
      if (this.archivedMemories.has(memoryId)) continue;
      const similarity = cosineSimilarity(queryEmbedding.embedding, stored.vector);
      if (similarity < minSimilarity) continue;
      const node = this.nodes.get(memory.nodeId);
      scored.push({
        id: memoryId,
        title: memory.title,
        node_path: node?.relativePath ?? "",
        similarity,
      });
    }

    const payload = shapeLocalSemanticCandidates({
      scored,
      lexical: collectLexicalIds({
        bundleMemories: query.bundleMemories,
        subtreeIndex: query.subtreeIndex,
        discoveryCandidateTitles: query.discoveryCandidateTitles,
      }),
      matchedNodePath: query.matchedNodePath,
      model: queryEmbedding.model,
      limit,
      minSimilarity,
    });

    return {
      payload,
      skipped: payload ? undefined : "no_candidates",
      latencyMs: Date.now() - start,
    };
  }

  capabilities(): BackendCapabilities {
    return {
      aiMerge: false,
      aiGenerate: false,
      staleness: false,
      realtime: false,
      // True only when an embedding key/seam is wired (honesty rule, enforced by
      // the editions matrix check). A bring-your-own embedding key enables
      // first-class semantic search.
      semantic: this.semanticEnabled,
      // True only when a bring-your-own router key is present (same honesty rule).
      routerLLM: hasAiRouteKey(),
    };
  }
}
