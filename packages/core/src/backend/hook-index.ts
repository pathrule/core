// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic hook-index assembly. Builds the full HookIndex the offline hook
 * supervisor reads: path_memories / path_rules / project_rules / recent_subjects
 * / session_digest / filename_index / skill_invocation_index / work_episode_index
 * + refresh counts. Shared by the SQLite-backed and in-memory backends. No
 * `better-sqlite3` import.
 *
 * `semantic_tags` are inferred (reusing shared `semanticTagsOrInfer`).
 * `block_pattern` / `symbols` / `enforcement` rule extraction, `fail_patterns`,
 * `promoted_rules_signature`, and `experiments` rely on curated/feature-flagged
 * data not available here and are intentionally omitted. Stub shapes match
 * @pathrule/shared/hook-supervisor.
 */
import { extractFilenameTokensFromPrompt } from "@pathrule/shared/hook-supervisor/matcher.js";
import type {
  HookIndex,
  MemoryStub,
  RuleStub,
  SkillInvocationStub,
  SkillStub,
  WorkEpisodeStub,
} from "@pathrule/shared/hook-supervisor/types.js";
import type { WorkEpisodeBrief } from "@pathrule/shared/intelligence/types.js";
import { semanticTagsOrInfer } from "@pathrule/shared/semantic-tags.js";
import { createHash } from "node:crypto";
import type { Warehouse } from "./inputs.js";

const PREVIEW_CHARS = 120;
const PER_BODY_BYTE_CAP = 3 * 1024;
const TOTAL_FILENAME_INDEX_BUDGET = 60 * 1024;
const SKILL_BODY_CAP = 6 * 1024;
const RECENT_SUBJECTS_LIMIT = 100;

/**
 * UTF-8 byte length. The body budgets above are byte caps, not character caps —
 * `String.length` counts UTF-16 code units, so multi-byte content (CJK, emoji,
 * accented text) would smuggle ~2-3x its intended byte size into the hook index
 * the supervisor reads on every tool call. Measure real bytes.
 */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export interface HookMemoryInput {
  id: string;
  title: string;
  content: string;
  node_path: string;
  semantic_tags?: string[] | null;
}
export interface HookRuleInput {
  id: string;
  name: string;
  content: string;
  scope_type: string;
  priority: string;
  /** Node paths this rule is attached to (via node_rules); empty for unattached. */
  node_paths: string[];
  semantic_tags?: string[] | null;
}
export interface HookSkillInput {
  id: string;
  name: string;
  description: string | null;
  content: string;
  source: string;
  github_url: string | null;
  /** Node paths this skill is attached to (via node_skills). Used by the
   *  knowledge compiler to place the skill in its directory's native file;
   *  empty/absent → compiled at the workspace root. */
  node_paths?: string[];
  semantic_tags?: string[] | null;
}
export interface HookActivityDigestRow {
  domain: string | null;
  action: string | null;
  node_path: string | null;
  task_summary: string | null;
}
export interface HookIndexInput {
  workspaceId: string;
  generatedAt: string;
  memories: HookMemoryInput[];
  rules: HookRuleInput[];
  skills: HookSkillInput[];
  /** Subjects per recent activity (last ~100), ranked into recent_subjects. */
  recentActivitySubjects: string[][];
  /** Last-30-min activities, summarised into session_digest. */
  recentActivityDigest: HookActivityDigestRow[];
  /** Medium/high-confidence episodes (from clusterEpisodes). */
  workEpisodes: WorkEpisodeBrief[];
  pendingRefreshCount: number;
  inProgressRefreshCount: number;
}

function truncatePreview(text: string, n: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, n);
}

/**
 * Change-detection key for delta injection: a stable sha256(content) prefix.
 * The delta gate re-injects a memory/rule/skill only when this differs from the
 * last-injected hash in the session ledger, so an unchanged item never re-enters
 * the agent context (cache-stability invariant).
 */
function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function normalizeSource(source: string): SkillInvocationStub["source"] {
  return source === "manual" || source === "template" || source === "github_ref"
    ? source
    : "manual";
}

function buildSessionDigest(
  digest: HookActivityDigestRow[],
  pending: number,
  inProgress: number,
): string | null {
  const parts: string[] = [];
  if (digest.length > 0) {
    const paths = [...new Set(digest.map((d) => d.node_path).filter((p): p is string => !!p))];
    const where = paths.length > 0 ? ` across ${paths.slice(0, 3).join(", ")}` : "";
    parts.push(`${digest.length} recent change${digest.length === 1 ? "" : "s"}${where}`);
  }
  if (pending > 0) parts.push(`${pending} pending refresh${pending === 1 ? "" : "es"}`);
  if (inProgress > 0) parts.push(`${inProgress} in progress`);
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Build the full-body warehouse: every memory/rule/skill keyed by id, no preview
 * truncation. This is the "data availability" layer — it does not enter the agent
 * context; delivery reads from it by id only for delta items. `content_hash` is
 * computed with the SAME function the index uses, so an item's warehouse hash and
 * index hash always agree — the delta gate relies on this.
 */
export function assembleWarehouse(input: HookIndexInput): Warehouse {
  const warehouse: Warehouse = {};
  for (const m of input.memories) {
    warehouse[m.id] = { type: "memory", title: m.title, body: m.content, content_hash: contentHash(m.content) };
  }
  for (const r of input.rules) {
    warehouse[r.id] = { type: "rule", title: r.name, body: r.content, content_hash: contentHash(r.content) };
  }
  for (const s of input.skills) {
    warehouse[s.id] = { type: "skill", title: s.name, body: s.content, content_hash: contentHash(s.content) };
  }
  return warehouse;
}

/** Assemble the full HookIndex (workspace_root left null — the CLI writer fills it). */
export function assembleHookIndex(input: HookIndexInput): HookIndex {
  // ── memories → path_memories + filename_index (with body budget) ──
  const tokensByMemory = new Map<string, string[]>();
  for (const m of input.memories) {
    const tokens = extractFilenameTokensFromPrompt(m.title);
    if (tokens.length > 0) tokensByMemory.set(m.id, tokens);
  }
  // Body budget: only token-bearing memories ≤ per-body cap, smallest-first until total budget.
  const bodyEligible = input.memories
    .map((m) => ({ m, bytes: byteLength(m.content) }))
    .filter((e) => tokensByMemory.has(e.m.id) && e.bytes <= PER_BODY_BYTE_CAP)
    .sort((a, b) => a.bytes - b.bytes || a.m.id.localeCompare(b.m.id));
  const bodyIds = new Set<string>();
  let runningBytes = 0;
  for (const { m, bytes } of bodyEligible) {
    runningBytes += bytes;
    if (runningBytes > TOTAL_FILENAME_INDEX_BUDGET) break;
    bodyIds.add(m.id);
  }

  const pathMemories: Record<string, MemoryStub[]> = {};
  const filenameIndex: Record<string, string[]> = {};
  for (const m of [...input.memories].sort((a, b) => a.id.localeCompare(b.id))) {
    const tokens = tokensByMemory.get(m.id);
    const stub: MemoryStub = {
      id: m.id,
      title: m.title,
      preview: truncatePreview(m.content, PREVIEW_CHARS),
      node_path: m.node_path,
      content_hash: contentHash(m.content),
      semantic_tags: semanticTagsOrInfer(m.semantic_tags, {
        text: `${m.title} ${m.content.slice(0, 1000)}`,
        path: m.node_path,
      }),
    };
    if (tokens) stub.filename_tokens = tokens;
    if (bodyIds.has(m.id)) stub.body = m.content;
    (pathMemories[m.node_path] ??= []).push(stub);
    for (const t of tokens ?? []) (filenameIndex[t] ??= []).push(m.id);
  }
  for (const ids of Object.values(filenameIndex)) ids.sort();

  // ── rules → project_rules + path_rules ──
  const projectRules: RuleStub[] = [];
  const pathRules: Record<string, RuleStub[]> = {};
  for (const r of [...input.rules].sort((a, b) => a.id.localeCompare(b.id))) {
    const base: RuleStub = {
      id: r.id,
      name: r.name,
      scope_type: r.scope_type as RuleStub["scope_type"],
      priority: r.priority as RuleStub["priority"],
      preview: truncatePreview(r.content, PREVIEW_CHARS),
      content_hash: contentHash(r.content),
      semantic_tags: semanticTagsOrInfer(r.semantic_tags, {
        text: `${r.name} ${r.content.slice(0, 1000)}`,
        path: null,
      }),
    };
    if (r.scope_type === "project") {
      projectRules.push(base);
    } else {
      for (const np of r.node_paths) {
        (pathRules[np] ??= []).push({ ...base, node_path: np });
      }
    }
  }

  // ── recent_subjects: rank by frequency, top 100 ──
  const subjectCounts = new Map<string, number>();
  for (const subs of input.recentActivitySubjects) {
    for (const s of subs) {
      if (s && s.length > 0) subjectCounts.set(s, (subjectCounts.get(s) ?? 0) + 1);
    }
  }
  const recentSubjects = [...subjectCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, RECENT_SUBJECTS_LIMIT)
    .map(([s]) => s);

  // ── skills → skill_invocation_index (keyed by normalized name) ──
  const skillIndex: Record<string, SkillInvocationStub[]> = {};
  for (const s of input.skills) {
    const key = s.name.trim().toLowerCase();
    if (!key) continue;
    const stub: SkillInvocationStub = {
      id: s.id,
      name: s.name,
      source: normalizeSource(s.source),
      github_url: s.github_url,
      node_path: null,
      preview: truncatePreview(s.content, PREVIEW_CHARS),
      content_hash: contentHash(s.content),
      semantic_tags: semanticTagsOrInfer(s.semantic_tags, {
        text: `${s.name} ${s.description ?? ""} ${s.content.slice(0, 1000)}`,
        path: null,
      }),
    };
    if (s.content.length >= 1 && byteLength(s.content) <= SKILL_BODY_CAP) stub.body = s.content;
    (skillIndex[key] ??= []).push(stub);
  }

  // ── skills → path_skills (path-scoped stubs for relevance top-k) ──
  // Mirrors path_memories so the hook can find a routed path's skills and rank
  // them against the prompt; bodies live in the warehouse, vectors in embeddings.json.
  const pathSkills: Record<string, SkillStub[]> = {};
  for (const s of input.skills) {
    const targets = s.node_paths && s.node_paths.length > 0 ? s.node_paths : ["/"];
    for (const np of targets) {
      (pathSkills[np] ??= []).push({
        id: s.id,
        name: s.name,
        node_path: np,
        preview: truncatePreview(s.content, PREVIEW_CHARS),
        content_hash: contentHash(s.content),
      });
    }
  }

  // ── work_episode_index ──
  const workEpisodeIndex: WorkEpisodeStub[] = input.workEpisodes.map((e) => ({
    id: e.id,
    title: truncatePreview(e.title, 120),
    summary: truncatePreview(e.summary, 260),
    subjects: e.subjects.slice(0, 6),
    paths: e.paths.slice(0, 8),
    activity_count: e.activity_count,
    started_at: e.started_at,
    ended_at: e.ended_at,
    confidence: e.confidence,
  }));

  // ── hot_paths: most-touched recent activity paths, top 8 ──
  const hotCounts = new Map<string, number>();
  for (const a of input.recentActivityDigest) {
    if (a.node_path && a.node_path !== "/") {
      hotCounts.set(a.node_path, (hotCounts.get(a.node_path) ?? 0) + 1);
    }
  }
  const hotPaths = [...hotCounts.entries()]
    .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]))
    .slice(0, 8)
    .map(([path, count]) => ({ path, count }));

  const index: HookIndex = {
    schema_version: 2,
    workspace_id: input.workspaceId,
    workspace_root: "",
    generated_at: input.generatedAt,
    path_memories: pathMemories,
    path_rules: pathRules,
    project_rules: projectRules,
    recent_subjects: recentSubjects,
    session_digest: buildSessionDigest(
      input.recentActivityDigest,
      input.pendingRefreshCount,
      input.inProgressRefreshCount,
    ),
    pending_refresh_count: input.pendingRefreshCount,
    in_progress_refresh_count: input.inProgressRefreshCount,
  };
  if (Object.keys(filenameIndex).length > 0) index.filename_index = filenameIndex;
  if (Object.keys(skillIndex).length > 0) index.skill_invocation_index = skillIndex;
  if (Object.keys(pathSkills).length > 0) index.path_skills = pathSkills;
  if (workEpisodeIndex.length > 0) index.work_episode_index = workEpisodeIndex;
  if (hotPaths.length > 0) index.hot_paths = hotPaths;
  return index;
}
