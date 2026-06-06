// SPDX-License-Identifier: Apache-2.0
/**
 * LocalBackend — the OSS edition's authoritative store: embedded SQLite.
 *
 * This is not a cache of a remote service — it is the source of truth for a single developer
 * running Pathrule with no login. Pass a file path (e.g. ~/.pathrule/<ws>/pathrule.db) or
 * ":memory:" (tests). Implements the KnowledgeBackend CRUD + tree + activity + refresh slice
 * faithfully; the context/intelligence formulas are reference-level implementations here.
 *
 * better-sqlite3 is synchronous; methods wrap results in Promise to satisfy the async contract.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  pathruleHome,
  PATHRULE_DIR_MODE,
  PATHRULE_FILE_MODE,
} from "@pathrule/shared/local-runtime/paths.js";
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
  RefreshStatus,
  PendingRefreshSummary,
  RequestRefreshResult,
} from "@pathrule/shared/tools/refresh-types.js";
import { pathsEqual, pathStartsWith } from "@pathrule/shared/path-compare.js";
import { normalizeNodePath, guessLeafType } from "@pathrule/shared/tools/node-path.js";
import { buildWorkspaceOverview } from "@pathrule/shared/tools/overview.js";
import { runAiRouteAdapter, hasAiRouteKey } from "../ai-route-adapter.js";
import type { BackendCapabilities } from "../capabilities.js";
import type { KnowledgeBackend } from "../knowledge-backend.js";
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
} from "../inputs.js";
import { MIGRATIONS } from "./schema.js";
import {
  normalizeActivitySubjects,
  localEntryToRefreshRow,
  localEntryToSummary,
  type LocalRefreshEntry,
  type RefreshSubjectSnapshot,
} from "../in-memory-backend.js";
import { rankProjectMap, type ProjectMapCandidate } from "../project-map-rank.js";
import { activityTouchedPaths, rankCoupledPaths } from "../co-change-rank.js";
import { searchEpisodes, clusterEpisodes, type EpisodeActivity } from "../work-episodes.js";
import { assembleBriefingLocal } from "../briefing.js";
import { assembleHookIndex, type HookRuleInput } from "../hook-index.js";
import { resolveLocalPrincipal } from "./identity.js";
import { embedTextBYO, hasEmbeddingKey, type EmbedFn } from "../embedding-adapter.js";
import {
  cosineSimilarity,
  composeEmbeddingText,
  collectLexicalIds,
  shapeLocalSemanticCandidates,
  type ScoredCandidate,
  SEMANTIC_SCAN_TOP_K,
  SEMANTIC_QUERY_MIN_SIMILARITY,
} from "../semantic-rank.js";

type Db = InstanceType<typeof Database>;

/** Strip trailing slashes from a path. */
function normalizePathTail(p: string): string {
  return p.replace(/\/+$/, "");
}

/**
 * Canonicalize a workspace root / cwd to its real on-disk path (resolving symlinks),
 * then strip trailing slashes. `pathrule init` and the MCP server can observe the
 * same directory under different symlinked forms (e.g. macOS `/var` → `/private/var`,
 * or a repo reached via a symlink); without canonicalization the longest-prefix match
 * fails and the agent is told "no workspace covers this folder" right after init.
 * Falls back to the trailing-slash-trimmed input if the path can't be resolved
 * (doesn't exist, permission), so a missing/stale dir never throws here.
 */
function canonicalizePath(p: string): string {
  try {
    return normalizePathTail(realpathSync(p));
  } catch {
    return normalizePathTail(p);
  }
}

/** Pack an embedding vector into a float32 BLOB for the `memory_embeddings.embedding` column. */
function vectorToBlob(vector: number[]): Buffer {
  // new Float32Array(vector) owns a fresh, exactly-sized ArrayBuffer (offset 0).
  return Buffer.from(new Float32Array(vector).buffer);
}

/**
 * Read a float32 BLOB back as a vector. Returns null when the byte length isn't a
 * whole number of float32s or doesn't match the row's declared `dims` (a truncated /
 * hand-corrupted store) so the caller can skip it instead of scoring garbage.
 */
function blobToVector(blob: Buffer, dims: number): Float32Array | null {
  if (blob.byteLength !== dims * 4) return null;
  // View the exact bytes — a Node Buffer can be a slice of a larger pooled ArrayBuffer.
  return new Float32Array(blob.buffer, blob.byteOffset, dims);
}

/** Safely parse a JSON text column into a string[] (empty on null/garbage). */
function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

/** Re-hydrate a stored files_touched JSON string into its object shape. */
function parseFilesTouchedJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export interface LocalBackendOptions {
  genId?: () => string;
  now?: () => string;
  /** Identity stamped on created_by/last_edited_by. Defaults to the resolved local principal. */
  principal?: string;
  /**
   * Injectable embedding seam (tests pass a deterministic stub).
   * Defaults to the bring-your-own provider adapter. When provided, semantic search is
   * enabled regardless of env keys; otherwise it follows hasEmbeddingKey().
   */
  embed?: EmbedFn;
}

interface MemoryRow {
  id: string;
  workspace_id: string;
  node_id: string;
  title: string;
  content: string;
  source: string;
  version_id: string;
  version_number: number;
  created_by: string | null;
  last_edited_by: string | null;
  last_edited_at: string;
  created_at: string;
  updated_at: string;
}
interface RuleRow {
  id: string;
  workspace_id: string;
  name: string;
  content: string;
  scope_type: string;
  priority: string;
  version_id: string;
  version_number: number;
  created_by: string | null;
  last_edited_by: string | null;
  last_edited_at: string;
  created_at: string;
  updated_at: string;
}
interface SkillRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  content: string;
  source: string;
  github_url: string | null;
  version: string;
  tags: string;
  version_id: string;
  version_number: number;
  created_by: string | null;
  last_edited_by: string | null;
  last_edited_at: string;
  created_at: string;
  updated_at: string;
  content_fetched_at: string | null;
}

export class LocalBackend implements KnowledgeBackend {
  private readonly db: Db;
  private readonly genId: () => string;
  private readonly now: () => string;
  private readonly principal: string;
  private readonly embed: EmbedFn;
  /** True when semantic search is wired (injected embed or a BYO key). */
  private readonly semanticEnabled: boolean;

  constructor(path = ":memory:", options: LocalBackendOptions = {}) {
    this.db = new Database(path);
    if (path !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
    }
    this.runMigrations();
    this.genId = options.genId ?? (() => randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.principal = options.principal ?? resolveLocalPrincipal();
    this.embed = options.embed ?? ((text, opts) => embedTextBYO(text, opts));
    this.semanticEnabled = options.embed !== undefined || hasEmbeddingKey();
  }

  /**
   * Open the canonical OSS store at `~/.pathrule/<workspaceId>/pathrule.db` (honoring
   * `PATHRULE_HOME`), creating the directory (0700) and tightening the db file to 0600.
   * This is the source of truth for a single developer — not a cache of a remote service.
   */
  static openForWorkspace(
    workspaceId: string,
    env: NodeJS.ProcessEnv = process.env,
    options: LocalBackendOptions = {},
  ): LocalBackend {
    const dir = join(pathruleHome(env), workspaceId);
    mkdirSync(dir, { recursive: true, mode: PATHRULE_DIR_MODE });
    const dbPath = join(dir, "pathrule.db");
    const backend = new LocalBackend(dbPath, options);
    try {
      chmodSync(dbPath, PATHRULE_FILE_MODE);
    } catch {
      // Best-effort on platforms without POSIX perms (e.g. Windows).
    }
    return backend;
  }

  /**
   * Discover which local workspace store serves a cwd, WITHOUT opening
   * a writable backend first. Scans `~/.pathrule/<id>/pathrule.db` (honoring
   * `PATHRULE_HOME`), reads each store's `workspaces.local_root_path` (read-only,
   * no migration), and longest-prefix-matches the cwd — the same rule as
   * resolveWorkspaceFromCwd, but across the per-workspace stores.
   * Returns null when no local workspace covers the path (caller → `pathrule init`).
   * This is the OSS CLI's entry primitive: pick the workspace, then
   * `openForWorkspace(match.workspaceId)`.
   */
  static discoverWorkspaceForCwd(
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
  ): WorkspaceMatch | null {
    const home = pathruleHome(env);
    if (!existsSync(home)) return null;
    const normalizedCwd = canonicalizePath(cwd);

    const candidates: Array<{ wid: string; root: string }> = [];
    let entries: string[];
    try {
      entries = readdirSync(home);
    } catch {
      return null;
    }
    for (const id of entries) {
      const dbPath = join(home, id, "pathrule.db");
      if (!existsSync(dbPath)) continue;
      let db: Db | undefined;
      try {
        db = new Database(dbPath, { readonly: true });
        const row = db
          .prepare(
            "SELECT id, local_root_path FROM workspaces WHERE local_root_path IS NOT NULL LIMIT 1",
          )
          .get() as { id: string; local_root_path: string } | undefined;
        if (row) candidates.push({ wid: row.id, root: normalizePathTail(row.local_root_path) });
      } catch {
        // Skip an unreadable / pre-schema store rather than failing discovery.
      } finally {
        db?.close();
      }
    }

    const best = candidates
      .filter((c) => pathsEqual(normalizedCwd, c.root) || pathStartsWith(normalizedCwd, c.root))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (!best) return null;
    return {
      workspaceId: best.wid,
      localRootPath: best.root,
      relativePath: pathsEqual(normalizedCwd, best.root)
        ? ""
        : normalizedCwd.slice(best.root.length),
    };
  }

  /** Apply append-only migrations gated on PRAGMA user_version. Idempotent + transactional. */
  private runMigrations(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      const apply = this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db.pragma(`user_version = ${migration.version}`);
      });
      apply();
    }
  }

  /** Release the SQLite handle. */
  close(): void {
    this.db.close();
  }

  sessionIsCurrent(): Promise<boolean> {
    return Promise.resolve(true);
  }

  // ── workspace resolution ──────────────────────────────────────────────────
  /**
   * Register/refresh a local workspace's root path (idempotent). The OSS runtime
   * (`pathrule init`) calls this so resolveWorkspaceFromCwd can map a
   * cwd back to this workspace. Not on the cross-edition interface — the hosted
   * edition creates workspaces via onboarding, not this path.
   */
  registerWorkspace(input: { workspaceId: string; name?: string; localRootPath: string }): void {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, local_root_path, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           local_root_path = excluded.local_root_path,
           name = COALESCE(excluded.name, workspaces.name)`,
      )
      .run(
        input.workspaceId,
        input.name ?? input.workspaceId,
        canonicalizePath(input.localRootPath),
        this.now(),
      );
  }

  resolveWorkspaceFromCwd(cwd: string): Promise<WorkspaceMatch | null> {
    const normalizedCwd = canonicalizePath(cwd);
    const rows = this.db
      .prepare("SELECT id, local_root_path FROM workspaces WHERE local_root_path IS NOT NULL")
      .all() as Array<{ id: string; local_root_path: string }>;
    const best = rows
      .map((r) => ({ wid: r.id, root: normalizePathTail(r.local_root_path) }))
      .filter((r) => pathsEqual(normalizedCwd, r.root) || pathStartsWith(normalizedCwd, r.root))
      .sort((a, b) => b.root.length - a.root.length)[0];
    if (!best) return Promise.resolve(null);
    const relativePath = pathsEqual(normalizedCwd, best.root)
      ? ""
      : normalizedCwd.slice(best.root.length);
    return Promise.resolve({
      workspaceId: best.wid,
      localRootPath: best.root,
      relativePath,
    });
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
    candidates.push(""); // workspace root last
    const rows = this.db
      .prepare(
        `SELECT id, relative_path FROM nodes
          WHERE workspace_id = ? AND relative_path IN (${candidates.map(() => "?").join(",")})`,
      )
      .all(workspaceId, ...candidates) as Array<{ id: string; relative_path: string }>;
    const byPath = new Map(rows.map((r) => [r.relative_path, r.id]));
    for (const candidate of candidates) {
      const id = byPath.get(candidate);
      if (id) return Promise.resolve({ id, relativePath: candidate });
    }
    return Promise.resolve(null);
  }

  // ── memory CRUD ──────────────────────────────────────────────────────────
  private toMemory(r: MemoryRow): Memory {
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      nodeId: r.node_id,
      title: r.title,
      content: r.content,
      source: r.source as Memory["source"],
      versionId: r.version_id,
      versionNumber: r.version_number,
      createdBy: r.created_by,
      lastEditedBy: r.last_edited_by,
      lastEditedAt: r.last_edited_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  readMemory(id: string): Promise<Memory | null> {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'")
      .get(id) as MemoryRow | undefined;
    return Promise.resolve(row ? this.toMemory(row) : null);
  }

  /**
   * Best-effort embed + upsert for one memory. No-op when semantic is unwired;
   * swallows provider/network failures (the write already succeeded — a missing
   * embedding just means that memory won't surface in semantic search yet).
   */
  private async embedAndStore(
    memoryId: string,
    workspaceId: string,
    title: string,
    content: string,
  ): Promise<void> {
    if (!this.semanticEnabled) return;
    try {
      const result = await this.embed(composeEmbeddingText(title, content), {
        inputType: "document",
      });
      if (!result) return;
      this.db
        .prepare(
          `INSERT INTO memory_embeddings (memory_id, workspace_id, model, dims, embedding, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(memory_id) DO UPDATE SET
             model = excluded.model, dims = excluded.dims,
             embedding = excluded.embedding, created_at = excluded.created_at`,
        )
        .run(
          memoryId,
          workspaceId,
          result.model,
          result.dims,
          vectorToBlob(result.embedding),
          this.now(),
        );
    } catch {
      // Best-effort: a failed embedding never fails the memory write.
    }
  }

  async writeMemory(input: WriteMemoryInput): Promise<Memory> {
    const ts = this.now();
    const row: MemoryRow = {
      id: this.genId(),
      workspace_id: input.workspaceId,
      node_id: input.nodeId ?? "",
      title: input.title,
      content: input.content,
      source: input.source ?? "claude",
      version_id: this.genId(),
      version_number: 1,
      created_by: this.principal,
      last_edited_by: this.principal,
      last_edited_at: ts,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO memories (id, workspace_id, node_id, title, content, source, version_id,
          version_number, created_by, last_edited_by, last_edited_at, created_at, updated_at)
         VALUES (@id, @workspace_id, @node_id, @title, @content, @source, @version_id,
          @version_number, @created_by, @last_edited_by, @last_edited_at, @created_at, @updated_at)`,
      )
      .run(row);
    await this.embedAndStore(row.id, row.workspace_id, row.title, row.content);
    return this.toMemory(row);
  }

  async updateMemory(input: UpdateMemoryInput): Promise<Memory> {
    const existing = await this.readMemory(input.id);
    if (!existing) throw new Error(`memory ${input.id} not found`);
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE memories SET title = ?, content = ?, node_id = ?, version_id = ?, version_number = ?,
          last_edited_by = ?, last_edited_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.title ?? existing.title,
        input.content ?? existing.content,
        input.nodeId ?? existing.nodeId,
        this.genId(),
        existing.versionNumber + 1,
        this.principal,
        ts,
        ts,
        input.id,
      );
    const updated = await this.readMemory(input.id);
    if (!updated) throw new Error(`memory ${input.id} vanished after update`);
    // Re-embed only when the embedded text actually changed. A node-only re-home
    // (move_to_path) leaves title+content untouched, and embedAndStore is a paid
    // network round-trip — skip it when nothing the vector depends on moved.
    const textChanged = updated.title !== existing.title || updated.content !== existing.content;
    if (textChanged) {
      await this.embedAndStore(updated.id, updated.workspaceId, updated.title, updated.content);
    }
    return updated;
  }

  /**
   * Soft/hard delete shared by the memory, rule, and skill delete methods. The three
   * differ only in data: which table, which child-link rows to purge on a hard delete,
   * and whether a node id is carried back. Behavior is identical — not-found and
   * optimistic-version-conflict are checked the same way, and a soft delete just flips
   * the row to `archived` (restore re-includes it). There are no FK cascades in the
   * schema, so a hard delete purges child rows explicitly (children first, then the row).
   */
  private async deleteContent(
    input: DeleteContentInput,
    spec: {
      read: (id: string) => Promise<{
        id: string;
        workspaceId: string;
        versionId: string;
        nodeId?: string | null;
      } | null>;
      table: "memories" | "rules" | "skills";
      /** Link/derived tables to purge on a hard delete (none on a soft delete). */
      childTables: ReadonlyArray<{ table: string; column: string }>;
    },
  ): Promise<DeleteContentResult> {
    const existing = await spec.read(input.id);
    if (!existing) return { status: "rejected", reason: "not_found" };
    if (input.expectedVersionId && existing.versionId !== input.expectedVersionId) {
      return { status: "conflict", currentVersionId: existing.versionId };
    }
    if (input.hard) {
      for (const child of spec.childTables) {
        this.db.prepare(`DELETE FROM ${child.table} WHERE ${child.column} = ?`).run(input.id);
      }
      this.db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(input.id);
    } else {
      this.db.prepare(`UPDATE ${spec.table} SET status = 'archived' WHERE id = ?`).run(input.id);
    }
    return {
      status: "deleted",
      id: existing.id,
      workspaceId: existing.workspaceId,
      nodeId: existing.nodeId ?? null,
    };
  }

  deleteMemory(input: DeleteContentInput): Promise<DeleteContentResult> {
    // Hard delete also purges the embedding + context-path rows (no FK cascade);
    // a soft delete leaves them — semanticCandidates joins only active memories,
    // so archived rows never surface, and restore re-includes them.
    return this.deleteContent(input, {
      read: (id) => this.readMemory(id),
      table: "memories",
      childTables: [
        { table: "memory_embeddings", column: "memory_id" },
        { table: "memory_context_paths", column: "memory_id" },
      ],
    });
  }

  /** Flip an archived row back to active. Shared by the three restore methods. */
  private restoreContent(
    table: "memories" | "rules" | "skills",
    id: string,
    withNode: boolean,
  ): RestoreContentResult {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, status${withNode ? ", node_id" : ""} FROM ${table} WHERE id = ?`,
      )
      .get(id) as
      | { id: string; workspace_id: string; status: string; node_id?: string }
      | undefined;
    if (!row) return { status: "rejected", reason: "not_found" };
    if (row.status !== "archived") return { status: "rejected", reason: "not_deleted" };
    this.db.prepare(`UPDATE ${table} SET status = 'active' WHERE id = ?`).run(id);
    return {
      status: "restored",
      id: row.id,
      workspaceId: row.workspace_id,
      nodeId: row.node_id ?? null,
    };
  }

  restoreMemory(id: string): Promise<RestoreContentResult> {
    return Promise.resolve(this.restoreContent("memories", id, true));
  }

  listMemories(query: ListMemoriesQuery): Promise<Memory[]> {
    const status = query.status ?? "active";
    const rows = (
      query.nodeId === undefined
        ? this.db
            .prepare(
              "SELECT * FROM memories WHERE workspace_id = ? AND status = ? ORDER BY created_at",
            )
            .all(query.workspaceId, status)
        : this.db
            .prepare(
              "SELECT * FROM memories WHERE workspace_id = ? AND node_id = ? AND status = ? ORDER BY created_at",
            )
            .all(query.workspaceId, query.nodeId, status)
    ) as MemoryRow[];
    return Promise.resolve(rows.map((r) => this.toMemory(r)));
  }

  // ── rule CRUD ──────────────────────────────────────────────────────────────
  private toRule(r: RuleRow): Rule {
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      content: r.content,
      scopeType: r.scope_type as Rule["scopeType"],
      priority: r.priority as Rule["priority"],
      versionId: r.version_id,
      versionNumber: r.version_number,
      createdBy: r.created_by,
      lastEditedBy: r.last_edited_by,
      lastEditedAt: r.last_edited_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  readRule(id: string): Promise<Rule | null> {
    const row = this.db
      .prepare("SELECT * FROM rules WHERE id = ? AND status = 'active'")
      .get(id) as RuleRow | undefined;
    return Promise.resolve(row ? this.toRule(row) : null);
  }

  writeRule(input: WriteRuleInput): Promise<Rule> {
    const ts = this.now();
    const row: RuleRow = {
      id: this.genId(),
      workspace_id: input.workspaceId,
      name: input.name,
      content: input.content,
      scope_type: input.scopeType,
      priority: input.priority ?? "medium",
      version_id: this.genId(),
      version_number: 1,
      created_by: this.principal,
      last_edited_by: this.principal,
      last_edited_at: ts,
      created_at: ts,
      updated_at: ts,
    };
    this.db
      .prepare(
        `INSERT INTO rules (id, workspace_id, name, content, scope_type, priority, version_id,
          version_number, created_by, last_edited_by, last_edited_at, created_at, updated_at)
         VALUES (@id, @workspace_id, @name, @content, @scope_type, @priority, @version_id,
          @version_number, @created_by, @last_edited_by, @last_edited_at, @created_at, @updated_at)`,
      )
      .run(row);
    if (input.nodeId) {
      this.db
        .prepare("INSERT OR IGNORE INTO node_rules (node_id, rule_id) VALUES (?, ?)")
        .run(input.nodeId, row.id);
    }
    return Promise.resolve(this.toRule(row));
  }

  async updateRule(input: UpdateRuleInput): Promise<Rule> {
    const existing = await this.readRule(input.id);
    if (!existing) throw new Error(`rule ${input.id} not found`);
    const ts = this.now();
    this.db
      .prepare(
        `UPDATE rules SET name = ?, content = ?, scope_type = ?, priority = ?, version_id = ?,
          version_number = ?, last_edited_by = ?, last_edited_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.name ?? existing.name,
        input.content ?? existing.content,
        input.scopeType ?? existing.scopeType,
        input.priority ?? existing.priority,
        this.genId(),
        existing.versionNumber + 1,
        this.principal,
        ts,
        ts,
        input.id,
      );
    if (input.nodeId) {
      // Re-home: replace any existing attachments with one pointing at the new node.
      this.db.prepare("DELETE FROM node_rules WHERE rule_id = ?").run(input.id);
      this.db
        .prepare("INSERT OR IGNORE INTO node_rules (node_id, rule_id) VALUES (?, ?)")
        .run(input.nodeId, input.id);
    }
    const updated = await this.readRule(input.id);
    if (!updated) throw new Error(`rule ${input.id} vanished after update`);
    return updated;
  }

  deleteRule(input: DeleteContentInput): Promise<DeleteContentResult> {
    return this.deleteContent(input, {
      read: (id) => this.readRule(id),
      table: "rules",
      childTables: [{ table: "node_rules", column: "rule_id" }],
    });
  }

  restoreRule(id: string): Promise<RestoreContentResult> {
    return Promise.resolve(this.restoreContent("rules", id, false));
  }

  listRules(query: ListRulesQuery): Promise<Rule[]> {
    const rows = this.db
      .prepare("SELECT * FROM rules WHERE workspace_id = ? AND status = ?")
      .all(query.workspaceId, query.status ?? "active") as RuleRow[];
    return Promise.resolve(rows.map((r) => this.toRule(r)));
  }

  // ── skill CRUD ───────────────────────────────────────────────────────────────
  private toSkill(r: SkillRow): Skill {
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      description: r.description,
      content: r.content,
      source: r.source as Skill["source"],
      githubUrl: r.github_url,
      version: r.version,
      tags: parseJsonArray(r.tags),
      versionId: r.version_id,
      versionNumber: r.version_number,
      createdBy: r.created_by,
      lastEditedBy: r.last_edited_by,
      lastEditedAt: r.last_edited_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      contentFetchedAt: r.content_fetched_at,
    };
  }

  readSkill(id: string): Promise<Skill | null> {
    const row = this.db
      .prepare("SELECT * FROM skills WHERE id = ? AND status = 'active'")
      .get(id) as SkillRow | undefined;
    return Promise.resolve(row ? this.toSkill(row) : null);
  }

  writeSkill(input: WriteSkillInput): Promise<Skill> {
    const ts = this.now();
    const source = input.source ?? "manual";
    const row: SkillRow = {
      id: this.genId(),
      workspace_id: input.workspaceId,
      name: input.name,
      description: input.description ?? null,
      content: input.content,
      source,
      github_url: input.githubUrl ?? null,
      version: "1.0.0",
      tags: JSON.stringify(input.tags ?? []),
      version_id: this.genId(),
      version_number: 1,
      created_by: this.principal,
      last_edited_by: this.principal,
      last_edited_at: ts,
      created_at: ts,
      updated_at: ts,
      content_fetched_at: source === "github_ref" ? ts : null,
    };
    this.db
      .prepare(
        `INSERT INTO skills (id, workspace_id, name, description, content, source, github_url,
          version, tags, version_id, version_number, created_by, last_edited_by, last_edited_at,
          created_at, updated_at, content_fetched_at)
         VALUES (@id, @workspace_id, @name, @description, @content, @source, @github_url,
          @version, @tags, @version_id, @version_number, @created_by, @last_edited_by, @last_edited_at,
          @created_at, @updated_at, @content_fetched_at)`,
      )
      .run(row);
    if (input.nodeId) {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO node_skills (node_id, skill_id, is_active) VALUES (?, ?, 1)",
        )
        .run(input.nodeId, row.id);
    }
    return Promise.resolve(this.toSkill(row));
  }

  async updateSkill(input: UpdateSkillInput): Promise<Skill> {
    const existing = await this.readSkill(input.id);
    if (!existing) throw new Error(`skill ${input.id} not found`);
    const ts = this.now();
    // Patch only supplied fields (null clears description/github_url; never reorder).
    const sets = [
      "version_id = ?",
      "version_number = ?",
      "last_edited_by = ?",
      "last_edited_at = ?",
      "updated_at = ?",
    ];
    const vals: unknown[] = [this.genId(), existing.versionNumber + 1, this.principal, ts, ts];
    if (input.name !== undefined) (sets.push("name = ?"), vals.push(input.name));
    if (input.content !== undefined) (sets.push("content = ?"), vals.push(input.content));
    if (input.description !== undefined)
      (sets.push("description = ?"), vals.push(input.description));
    if (input.source !== undefined) (sets.push("source = ?"), vals.push(input.source));
    if (input.githubUrl !== undefined) (sets.push("github_url = ?"), vals.push(input.githubUrl));
    if (input.tags !== undefined) (sets.push("tags = ?"), vals.push(JSON.stringify(input.tags)));
    const effectiveSource = input.source ?? existing.source;
    if (input.content !== undefined && effectiveSource === "github_ref") {
      sets.push("content_fetched_at = ?");
      vals.push(ts);
    }
    vals.push(input.id);
    this.db.prepare(`UPDATE skills SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
    if (input.nodeId) {
      this.db.prepare("DELETE FROM node_skills WHERE skill_id = ?").run(input.id);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO node_skills (node_id, skill_id, is_active) VALUES (?, ?, 1)",
        )
        .run(input.nodeId, input.id);
    }
    const updated = await this.readSkill(input.id);
    if (!updated) throw new Error(`skill ${input.id} vanished after update`);
    return updated;
  }

  deleteSkill(input: DeleteContentInput): Promise<DeleteContentResult> {
    return this.deleteContent(input, {
      read: (id) => this.readSkill(id),
      table: "skills",
      childTables: [{ table: "node_skills", column: "skill_id" }],
    });
  }

  restoreSkill(id: string): Promise<RestoreContentResult> {
    return Promise.resolve(this.restoreContent("skills", id, false));
  }

  listSkills(query: ListSkillsQuery): Promise<Skill[]> {
    const rows = this.db
      .prepare("SELECT * FROM skills WHERE workspace_id = ? AND status = ?")
      .all(query.workspaceId, query.status ?? "active") as SkillRow[];
    return Promise.resolve(rows.map((r) => this.toSkill(r)));
  }

  // ── tree ─────────────────────────────────────────────────────────────────────
  private toTreeNode(r: Record<string, unknown>): TreeNode {
    return {
      id: r["id"] as string,
      workspaceId: r["workspace_id"] as string,
      parentId: (r["parent_id"] as string | null) ?? null,
      name: r["name"] as string,
      type: r["type"] as TreeNode["type"],
      relativePath: r["relative_path"] as string,
      orderIndex: r["order_index"] as number,
      status: r["status"] as TreeNode["status"],
      orphanedAt: (r["orphaned_at"] as string | null) ?? null,
      originalPath: (r["original_path"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      updatedAt: r["updated_at"] as string,
    };
  }

  getTree(workspaceId: string): Promise<TreeNode[]> {
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE workspace_id = ? ORDER BY order_index")
      .all(workspaceId) as Array<Record<string, unknown>>;
    return Promise.resolve(rows.map((r) => this.toTreeNode(r)));
  }

  getNode(nodeId: string): Promise<TreeNode | null> {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as
      | Record<string, unknown>
      | undefined;
    return Promise.resolve(row ? this.toTreeNode(row) : null);
  }

  getNodeDetail(nodeId: string): Promise<NodeDetailRecord | null> {
    const node = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as
      | Record<string, unknown>
      | undefined;
    if (!node) return Promise.resolve(null);
    const memoryIds = (
      this.db
        .prepare("SELECT id FROM memories WHERE node_id = ? AND status = 'active'")
        .all(nodeId) as Array<{ id: string }>
    ).map((r) => r.id);
    const ruleIds = (
      this.db.prepare("SELECT rule_id FROM node_rules WHERE node_id = ?").all(nodeId) as Array<{
        rule_id: string;
      }>
    ).map((r) => r.rule_id);
    const skillIds = (
      this.db
        .prepare("SELECT skill_id FROM node_skills WHERE node_id = ? AND is_active = 1")
        .all(nodeId) as Array<{ skill_id: string }>
    ).map((r) => r.skill_id);
    return Promise.resolve({
      id: node["id"] as string,
      workspaceId: node["workspace_id"] as string,
      parentId: (node["parent_id"] as string | null) ?? null,
      name: node["name"] as string,
      type: node["type"] as string,
      relativePath: node["relative_path"] as string,
      memoryIds,
      ruleIds,
      skillIds,
    });
  }

  workspaceOverview(workspaceId: string, excludeNodeId?: string): Promise<WorkspaceOverviewNode[]> {
    const nodes = (
      this.db
        .prepare("SELECT id, relative_path FROM nodes WHERE workspace_id = ? AND status = 'active'")
        .all(workspaceId) as Array<{ id: string; relative_path: string }>
    ).map((n) => ({ id: n.id, relativePath: n.relative_path }));
    const memories = (
      this.db
        .prepare(
          "SELECT id, title, node_id FROM memories WHERE workspace_id = ? AND status = 'active' ORDER BY created_at ASC",
        )
        .all(workspaceId) as Array<{ id: string; title: string; node_id: string }>
    ).map((m) => ({ id: m.id, title: m.title, nodeId: m.node_id }));
    const rules = (
      this.db
        .prepare(
          `SELECT nr.node_id AS node_id, r.id AS id, r.name AS name, r.content AS content,
            r.scope_type AS scope_type, r.priority AS priority
           FROM node_rules nr JOIN rules r ON r.id = nr.rule_id
           WHERE r.workspace_id = ? AND r.status = 'active'`,
        )
        .all(workspaceId) as Array<{
        node_id: string;
        id: string;
        name: string;
        content: string;
        scope_type: string;
        priority: string;
      }>
    ).map((r) => ({
      nodeId: r.node_id,
      id: r.id,
      name: r.name,
      content: r.content,
      scopeType: r.scope_type,
      priority: r.priority,
    }));
    const skills = (
      this.db
        .prepare(
          `SELECT ns.node_id AS node_id, s.id AS id, s.name AS name, s.description AS description,
            s.source AS source, s.tags AS tags
           FROM node_skills ns JOIN skills s ON s.id = ns.skill_id
           WHERE ns.is_active = 1 AND s.workspace_id = ? AND s.status = 'active'`,
        )
        .all(workspaceId) as Array<{
        node_id: string;
        id: string;
        name: string;
        description: string | null;
        source: string;
        tags: string | null;
      }>
    ).map((s) => ({
      nodeId: s.node_id,
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
      tags: parseJsonArray(s.tags),
    }));
    return Promise.resolve(
      buildWorkspaceOverview({ nodes, memories, rules, skills, excludeNodeId }),
    );
  }

  findNodeByPath(workspaceId: string, relativePath: string): Promise<NodeRef | null> {
    const row = this.db
      .prepare(
        "SELECT id, name, relative_path FROM nodes WHERE workspace_id = ? AND relative_path = ? LIMIT 1",
      )
      .get(workspaceId, relativePath) as
      | { id: string; name: string; relative_path: string }
      | undefined;
    return Promise.resolve(
      row ? { id: row.id, name: row.name, relativePath: row.relative_path } : null,
    );
  }

  getNodeContent(nodeId: string): Promise<NodeContent> {
    const memories = (
      this.db
        .prepare(
          "SELECT id, title, content FROM memories WHERE node_id = ? AND status = 'active' ORDER BY created_at ASC",
        )
        .all(nodeId) as Array<{ id: string; title: string; content: string }>
    ).map((m) => ({ id: m.id, title: m.title, content: m.content }));
    const rules = (
      this.db
        .prepare(
          `SELECT r.id AS id, r.name AS name, r.content AS content, r.scope_type AS scope_type,
            r.priority AS priority
           FROM node_rules nr JOIN rules r ON r.id = nr.rule_id
           WHERE nr.node_id = ? AND r.status = 'active'`,
        )
        .all(nodeId) as Array<{
        id: string;
        name: string;
        content: string;
        scope_type: string;
        priority: string;
      }>
    ).map((r) => ({
      id: r.id,
      name: r.name,
      content: r.content,
      scopeType: r.scope_type,
      priority: r.priority,
    }));
    const skills = (
      this.db
        .prepare(
          `SELECT s.id AS id, s.name AS name, s.description AS description, s.source AS source,
            s.tags AS tags
           FROM node_skills ns JOIN skills s ON s.id = ns.skill_id
           WHERE ns.node_id = ? AND ns.is_active = 1 AND s.status = 'active'`,
        )
        .all(nodeId) as Array<{
        id: string;
        name: string;
        description: string | null;
        source: string;
        tags: string | null;
      }>
    ).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      source: s.source,
      tags: parseJsonArray(s.tags),
    }));
    return Promise.resolve({ memories, rules, skills });
  }

  listSkillsForInvocation(workspaceId: string): Promise<InvocationSkill[]> {
    const rows = this.db
      .prepare(
        "SELECT id, name, description, content, source, github_url FROM skills WHERE workspace_id = ? AND status = 'active'",
      )
      .all(workspaceId) as Array<{
      id: string;
      name: string;
      description: string | null;
      content: string;
      source: string;
      github_url: string | null;
    }>;
    return Promise.resolve(
      rows.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        content: s.content,
        source: s.source,
        githubUrl: s.github_url,
      })),
    );
  }

  getNodeForRule(ruleId: string): Promise<TreeNode | null> {
    const row = this.db
      .prepare("SELECT node_id FROM node_rules WHERE rule_id = ? LIMIT 1")
      .get(ruleId) as { node_id: string } | undefined;
    return row ? this.getNode(row.node_id) : Promise.resolve(null);
  }

  getNodeForSkill(skillId: string): Promise<TreeNode | null> {
    const row = this.db
      .prepare("SELECT node_id FROM node_skills WHERE skill_id = ? LIMIT 1")
      .get(skillId) as { node_id: string } | undefined;
    return row ? this.getNode(row.node_id) : Promise.resolve(null);
  }

  private selectNodeByPath(workspaceId: string, relativePath: string): MaterialisedNode | null {
    const row = this.db
      .prepare(
        "SELECT id, workspace_id, parent_id, name, type, relative_path FROM nodes WHERE workspace_id = ? AND relative_path = ?",
      )
      .get(workspaceId, relativePath) as MaterialisedNode | undefined;
    return row ?? null;
  }

  private insertNodeRow(
    workspaceId: string,
    parentId: string | null,
    name: string,
    type: MaterialisedNode["type"],
    relativePath: string,
    orderIndex: number,
  ): MaterialisedNode {
    const id = this.genId();
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO nodes (id, workspace_id, parent_id, name, type, relative_path, order_index, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, workspaceId, parentId, name, type, relativePath, orderIndex, ts, ts);
    return {
      id,
      workspace_id: workspaceId,
      parent_id: parentId,
      name,
      type,
      relative_path: relativePath,
    };
  }

  ensureNodeForPath(
    workspaceId: string,
    path: string,
    leafType?: MaterialisedNode["type"],
  ): Promise<MaterialisedNode> {
    // Port of shared/tools/nodes.ts materialisation over SQLite: ensure root, then
    // walk root→leaf creating folder ancestors and the typed leaf. The cumulative
    // path IS each node's relative_path, so no separate path builder is needed.
    const relativePath = normalizeNodePath(path);

    let root = this.selectNodeByPath(workspaceId, "/");
    if (!root) {
      const ws = this.db.prepare("SELECT name FROM workspaces WHERE id = ?").get(workspaceId) as
        | { name?: string }
        | undefined;
      root = this.insertNodeRow(workspaceId, null, ws?.name ?? "Workspace", "folder", "/", 0);
    }
    if (relativePath === "/") return Promise.resolve(root);

    const existing = this.selectNodeByPath(workspaceId, relativePath);
    if (existing) return Promise.resolve(existing);

    const segments = relativePath.split("/").filter((s) => s.length > 0);
    const resolvedLeafType = leafType ?? guessLeafType(relativePath);
    let parent = root;
    let cumulative = "";
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]!;
      cumulative += "/" + seg;
      const here = this.selectNodeByPath(workspaceId, cumulative);
      if (here) {
        parent = here;
        continue;
      }
      const { c } = this.db
        .prepare("SELECT COUNT(*) AS c FROM nodes WHERE workspace_id = ? AND parent_id = ?")
        .get(workspaceId, parent.id) as { c: number };
      const type = i === segments.length - 1 ? resolvedLeafType : "folder";
      parent = this.insertNodeRow(workspaceId, parent.id, seg, type, cumulative, c);
    }
    return Promise.resolve(parent);
  }

  // ── write guards / dedup ─────────────────────────────────────────────────
  isDemoWorkspace(_workspaceId: string): Promise<boolean> {
    return Promise.resolve(false); // OSS has no read-only demo workspaces.
  }

  checkContentDedup(args: DedupCheckArgs): Promise<DedupCheckResult> {
    // Local dedup applies the duplicate gate (normalised exact-title within scope);
    // the fuzzy `similar` list is not computed locally, so it is
    // empty here — the warning it powers is non-fatal.
    const norm = args.candidate.trim().toLowerCase();
    const exclude = args.excludeId ?? "";
    let row: { id: string; title: string } | undefined;
    if (args.kind === "memory") {
      row = this.db
        .prepare(
          "SELECT id, title FROM memories WHERE workspace_id = ? AND node_id = ? AND lower(trim(title)) = ? AND status = 'active' AND id != ? LIMIT 1",
        )
        .get(args.workspaceId, args.nodeId ?? "", norm, exclude) as
        | { id: string; title: string }
        | undefined;
    } else if (args.kind === "rule") {
      row = this.db
        .prepare(
          "SELECT id, name AS title FROM rules WHERE workspace_id = ? AND lower(trim(name)) = ? AND status = 'active' AND id != ? LIMIT 1",
        )
        .get(args.workspaceId, norm, exclude) as { id: string; title: string } | undefined;
    } else {
      row = this.db
        .prepare(
          "SELECT id, name AS title FROM skills WHERE workspace_id = ? AND lower(trim(name)) = ? AND status = 'active' AND id != ? LIMIT 1",
        )
        .get(args.workspaceId, norm, exclude) as { id: string; title: string } | undefined;
    }
    return Promise.resolve({ duplicate: row ?? null, similar: [] });
  }

  // ── context formulas (reference-level) ─────────────────────────────────────────
  subtreeMemoryIndex(scope: ContextScope, limit: number): Promise<SubtreeMemoryIndexResult> {
    const root = scope.relativePath || "/";
    // "/" → whole workspace; otherwise the node at root_path plus its descendants.
    // Descendants are expressed as a wildcard-free, case-sensitive half-open range
    // (`> root+'/'` .. `< root+'0'`, since '/'=0x2F and '0'=0x30) rather than a LIKE
    // pattern: LIKE would treat `%`/`_` in a path as wildcards AND match
    // case-insensitively, both of which diverge from InMemoryBackend's literal
    // `startsWith`. The range stays sargable on relative_path. See subtreeLo/subtreeHi.
    const pathClause =
      root === "/"
        ? ""
        : "AND (n.relative_path = @root OR (n.relative_path > @rootLo AND n.relative_path < @rootHi))";
    const bind = { ws: scope.workspaceId, root, rootLo: `${root}/`, rootHi: `${root}0`, limit };
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM memories m JOIN nodes n ON n.id = m.node_id
           WHERE m.workspace_id = @ws AND m.status = 'active' ${pathClause}`,
        )
        .get(bind) as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, m.title AS title, n.relative_path AS node_path
         FROM memories m JOIN nodes n ON n.id = m.node_id
         WHERE m.workspace_id = @ws AND m.status = 'active' ${pathClause}
         ORDER BY m.created_at ASC LIMIT @limit`,
      )
      .all(bind) as Array<{ id: string; title: string; node_path: string }>;
    return Promise.resolve({ entries: rows, truncated: total > rows.length, total });
  }

  // Fuzzy project-map search. Assemble every content-bearing node (path/name +
  // aggregated memory/rule/skill names + body preview) then rank in TS with the
  // shared trigram word-similarity ranker.
  projectMapSearch(
    workspaceId: string,
    query: string,
    limit = 15,
  ): Promise<ProjectMapSearchResult> {
    if (!query || query.trim().length === 0) {
      return Promise.resolve({ nodes: [], topScore: 0 });
    }
    return Promise.resolve(
      rankProjectMap(this.collectProjectMapCandidates(workspaceId), query, limit),
    );
  }

  /** Gather content-bearing nodes for project-map ranking (only nodes with ≥1 memory/rule/skill). */
  private collectProjectMapCandidates(workspaceId: string): ProjectMapCandidate[] {
    const nodes = this.db
      .prepare(
        "SELECT id, relative_path, name FROM nodes WHERE workspace_id = ? AND status = 'active'",
      )
      .all(workspaceId) as Array<{ id: string; relative_path: string; name: string }>;

    const memRows = this.db
      .prepare(
        "SELECT node_id, title, content FROM memories WHERE workspace_id = ? AND status = 'active' AND node_id != ''",
      )
      .all(workspaceId) as Array<{ node_id: string; title: string; content: string }>;
    const ruleRows = this.db
      .prepare(
        `SELECT nr.node_id AS node_id, r.name AS name, r.content AS content
         FROM node_rules nr JOIN rules r ON r.id = nr.rule_id
         WHERE r.workspace_id = ? AND r.status = 'active'`,
      )
      .all(workspaceId) as Array<{ node_id: string; name: string; content: string }>;
    const skillRows = this.db
      .prepare(
        `SELECT ns.node_id AS node_id, s.name AS name, s.content AS content
         FROM node_skills ns JOIN skills s ON s.id = ns.skill_id
         WHERE s.workspace_id = ? AND s.status = 'active'`,
      )
      .all(workspaceId) as Array<{ node_id: string; name: string; content: string }>;

    interface Agg {
      memTitles: string[];
      ruleNames: string[];
      skillNames: string[];
      memBodies: string[];
      ruleBodies: string[];
      skillBodies: string[];
    }
    const byNode = new Map<string, Agg>();
    const agg = (id: string): Agg => {
      let a = byNode.get(id);
      if (!a) {
        a = {
          memTitles: [],
          ruleNames: [],
          skillNames: [],
          memBodies: [],
          ruleBodies: [],
          skillBodies: [],
        };
        byNode.set(id, a);
      }
      return a;
    };
    for (const r of memRows) {
      const a = agg(r.node_id);
      a.memTitles.push(r.title);
      a.memBodies.push(r.content ?? "");
    }
    for (const r of ruleRows) {
      const a = agg(r.node_id);
      a.ruleNames.push(r.name);
      a.ruleBodies.push(r.content ?? "");
    }
    for (const r of skillRows) {
      const a = agg(r.node_id);
      a.skillNames.push(r.name);
      a.skillBodies.push(r.content ?? "");
    }

    const candidates: ProjectMapCandidate[] = [];
    for (const node of nodes) {
      const a = byNode.get(node.id);
      if (
        !a ||
        (a.memTitles.length === 0 && a.ruleNames.length === 0 && a.skillNames.length === 0)
      ) {
        continue;
      }
      const bodyPreview = [...a.memBodies, ...a.ruleBodies, ...a.skillBodies]
        .join(" ")
        .slice(0, 400);
      candidates.push({
        node_id: node.id,
        path: node.relative_path,
        name: node.name,
        memory_titles: a.memTitles,
        rule_names: a.ruleNames,
        skill_names: a.skillNames,
        body_preview: bodyPreview,
      });
    }
    return candidates;
  }

  // Hot paths derived from activity_logs (the local "who touched what" feed
  // populated by logActivity): top-5 node_paths by count over the last 7 days.
  getHotPaths(workspaceId: string): Promise<HotPath[]> {
    const since = new Date(Date.parse(this.now()) - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT node_path AS path, COUNT(*) AS change_count
         FROM activity_logs
         WHERE workspace_id = ? AND created_at >= ? AND node_path IS NOT NULL AND node_path != ''
         GROUP BY node_path
         ORDER BY change_count DESC, node_path ASC
         LIMIT 5`,
      )
      .all(workspaceId, since) as Array<{ path: string; change_count: number }>;
    return Promise.resolve(rows);
  }

  // Snapshot the paths active when a memory was written: read the last-30-min
  // activity_logs node_paths and upsert (memory_id, path). Best-effort, idempotent.
  recordMemoryContextPaths(memoryId: string, workspaceId: string): Promise<void> {
    const since = new Date(Date.parse(this.now()) - 30 * 60 * 1000).toISOString();
    const paths = this.db
      .prepare(
        `SELECT DISTINCT node_path AS path FROM activity_logs
         WHERE workspace_id = ? AND created_at >= ? AND node_path IS NOT NULL AND node_path != ''`,
      )
      .all(workspaceId, since) as Array<{ path: string }>;
    if (paths.length === 0) return Promise.resolve();
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO memory_context_paths (memory_id, path) VALUES (?, ?)",
    );
    const tx = this.db.transaction((rows: Array<{ path: string }>) => {
      for (const r of rows) insert.run(memoryId, r.path);
    });
    tx(paths);
    return Promise.resolve();
  }

  // Rank prior solutions: memories whose context paths overlap matchedPaths,
  // newest first, grouping the overlapping paths as related_paths.
  rankPriorSolutions(
    workspaceId: string,
    matchedPaths: string[],
    limit = 5,
  ): Promise<PriorSolution[]> {
    if (!matchedPaths || matchedPaths.length === 0) return Promise.resolve([]);
    const effectiveLimit = limit > 0 ? limit : 5;
    const placeholders = matchedPaths.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT m.id AS memory_id, m.title AS title, m.content AS content, m.created_at AS created_at,
                mcp.path AS path
         FROM memory_context_paths mcp
         JOIN memories m ON m.id = mcp.memory_id
         WHERE m.workspace_id = ? AND m.status = 'active' AND mcp.path IN (${placeholders})
         ORDER BY m.created_at DESC`,
      )
      .all(workspaceId, ...matchedPaths) as Array<{
      memory_id: string;
      title: string;
      content: string;
      created_at: string;
      path: string;
    }>;

    // Group overlapping paths per memory, preserving created_at-DESC memory order.
    const byMemory = new Map<string, PriorSolution>();
    for (const r of rows) {
      let entry = byMemory.get(r.memory_id);
      if (!entry) {
        entry = {
          memory_id: r.memory_id,
          title: r.title,
          preview: (r.content ?? "").slice(0, 200),
          related_paths: [],
          created_at: r.created_at,
        };
        byMemory.set(r.memory_id, entry);
      }
      if (!entry.related_paths.includes(r.path)) entry.related_paths.push(r.path);
    }
    return Promise.resolve([...byMemory.values()].slice(0, effectiveLimit));
  }

  // Co-change derived from activity_logs: paths touched together in one
  // activity. Returns NodeBriefs (match_source "co_change", relevance = min(1, weight/10)).
  findCoupledNodes(
    workspaceId: string,
    seedNodeIds: string[],
    seedPaths: string[],
    _changeLogCount: number,
  ): Promise<NodeBrief[]> {
    void _changeLogCount; // not applicable to the local derivation
    // Resolve seed node ids to their paths and merge with the explicit seed paths.
    const seedSet = new Set(seedPaths.filter(Boolean));
    if (seedNodeIds.length > 0) {
      const placeholders = seedNodeIds.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT relative_path FROM nodes WHERE workspace_id = ? AND id IN (${placeholders})`,
        )
        .all(workspaceId, ...seedNodeIds) as Array<{ relative_path: string }>;
      for (const r of rows) seedSet.add(r.relative_path);
    }
    if (seedSet.size === 0) return Promise.resolve([]);

    const activities = this.db
      .prepare("SELECT node_path, files_touched FROM activity_logs WHERE workspace_id = ?")
      .all(workspaceId) as Array<{ node_path: string | null; files_touched: string | null }>;
    const touched = activities.map((a) => {
      let byArea: Record<string, string[]> | null = null;
      if (a.files_touched) {
        try {
          const parsed = JSON.parse(a.files_touched) as { by_area?: Record<string, string[]> };
          byArea = parsed?.by_area ?? null;
        } catch {
          byArea = null;
        }
      }
      return activityTouchedPaths(byArea, a.node_path);
    });

    const coupled = rankCoupledPaths(touched, [...seedSet]);
    if (coupled.length === 0) return Promise.resolve([]);

    // Resolve coupled paths to nodes for names; unresolved paths use the path basename.
    const nodeByPath = new Map<string, { id: string; name: string }>();
    const placeholders = coupled.map(() => "?").join(", ");
    const nodeRows = this.db
      .prepare(
        `SELECT id, name, relative_path FROM nodes WHERE workspace_id = ? AND relative_path IN (${placeholders})`,
      )
      .all(workspaceId, ...coupled.map((c) => c.path)) as Array<{
      id: string;
      name: string;
      relative_path: string;
    }>;
    for (const n of nodeRows) nodeByPath.set(n.relative_path, { id: n.id, name: n.name });

    const briefs: NodeBrief[] = coupled.map((c) => {
      const node = nodeByPath.get(c.path);
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

  // Episodes are clustered on-read locally, so this refresh is a no-op.
  refreshWorkEpisodes(
    _workspaceId: string,
    _since?: string,
  ): Promise<{ ok: boolean; episodes_upserted: number }> {
    void _workspaceId;
    void _since;
    return Promise.resolve({ ok: true, episodes_upserted: 0 });
  }

  // Build EpisodeActivity[] from activity_logs (shared by searchWorkEpisodes + hook index).
  private collectEpisodeActivities(workspaceId: string): EpisodeActivity[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, domain, subjects, node_path, files_touched, task_summary
         FROM activity_logs WHERE workspace_id = ?`,
      )
      .all(workspaceId) as Array<{
      id: string;
      created_at: string;
      domain: string | null;
      subjects: string | null;
      node_path: string | null;
      files_touched: string | null;
      task_summary: string | null;
    }>;
    return rows.map((r) => {
      let byArea: Record<string, string[]> | null = null;
      if (r.files_touched) {
        try {
          byArea =
            (JSON.parse(r.files_touched) as { by_area?: Record<string, string[]> })?.by_area ??
            null;
        } catch {
          byArea = null;
        }
      }
      return {
        id: r.id,
        createdAt: r.created_at,
        domain: r.domain,
        subjects: parseJsonArray(r.subjects),
        touchedPaths: activityTouchedPaths(byArea, r.node_path),
        taskSummary: r.task_summary,
      };
    });
  }

  // Deterministic episode clustering over activity_logs, then query search.
  searchWorkEpisodes(
    workspaceId: string,
    query: string,
    _mode: "compact" | "deep",
    limit: number,
  ): Promise<WorkEpisodeBrief[]> {
    void _mode;
    return Promise.resolve(
      searchEpisodes(this.collectEpisodeActivities(workspaceId), query, limit),
    );
  }

  // Assemble the full offline HookIndex from the local store. Curation-only
  // fields (block_pattern/symbols/fail_patterns/promoted_rules_signature/experiments) are
  // omitted; semantic_tags are inferred (no local column). workspace_root left empty for the CLI.
  buildHookIndexPayload(workspaceId: string): Promise<HookIndex | null> {
    const memories = (
      this.db
        .prepare(
          `SELECT m.id, m.title, m.content, n.relative_path AS node_path
           FROM memories m JOIN nodes n ON n.id = m.node_id
           WHERE m.workspace_id = ? AND m.status = 'active'`,
        )
        .all(workspaceId) as Array<{
        id: string;
        title: string;
        content: string;
        node_path: string;
      }>
    ).map((m) => ({ ...m, semantic_tags: null }));

    const ruleRows = this.db
      .prepare(
        `SELECT id, name, content, scope_type, priority FROM rules WHERE workspace_id = ? AND status = 'active'`,
      )
      .all(workspaceId) as Array<{
      id: string;
      name: string;
      content: string;
      scope_type: string;
      priority: string;
    }>;
    const ruleNodePaths = this.db
      .prepare(
        `SELECT nr.rule_id AS rule_id, n.relative_path AS node_path
         FROM node_rules nr JOIN nodes n ON n.id = nr.node_id
         WHERE n.workspace_id = ?`,
      )
      .all(workspaceId) as Array<{ rule_id: string; node_path: string }>;
    const pathsByRule = new Map<string, string[]>();
    for (const r of ruleNodePaths) {
      const arr = pathsByRule.get(r.rule_id) ?? [];
      arr.push(r.node_path);
      pathsByRule.set(r.rule_id, arr);
    }
    const rules: HookRuleInput[] = ruleRows.map((r) => ({
      ...r,
      node_paths: pathsByRule.get(r.id) ?? [],
      semantic_tags: null,
    }));

    const skills = (
      this.db
        .prepare(
          `SELECT id, name, description, content, source, github_url FROM skills WHERE workspace_id = ? AND status = 'active'`,
        )
        .all(workspaceId) as Array<{
        id: string;
        name: string;
        description: string | null;
        content: string;
        source: string;
        github_url: string | null;
      }>
    ).map((s) => ({ ...s, semantic_tags: null }));

    const recentActs = this.db
      .prepare(
        `SELECT subjects, node_path, domain, action, task_summary, created_at
         FROM activity_logs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`,
      )
      .all(workspaceId) as Array<{
      subjects: string | null;
      node_path: string | null;
      domain: string | null;
      action: string | null;
      task_summary: string | null;
      created_at: string;
    }>;
    const since = new Date(Date.parse(this.now()) - 30 * 60 * 1000).toISOString();
    const recentActivitySubjects = recentActs.map((a) => parseJsonArray(a.subjects));
    const recentActivityDigest = recentActs
      .filter((a) => a.created_at >= since)
      .map((a) => ({
        domain: a.domain,
        action: a.action,
        node_path: a.node_path,
        task_summary: a.task_summary,
      }));

    const workEpisodes = clusterEpisodes(this.collectEpisodeActivities(workspaceId)).filter(
      (e) => e.confidence === "medium" || e.confidence === "high",
    );

    const counts = this.db
      .prepare(
        `SELECT status, COUNT(*) AS c FROM refresh_tasks
         WHERE workspace_id = ? AND status IN ('pending','in_progress') GROUP BY status`,
      )
      .all(workspaceId) as Array<{ status: string; c: number }>;
    const pendingRefreshCount = counts.find((c) => c.status === "pending")?.c ?? 0;
    const inProgressRefreshCount = counts.find((c) => c.status === "in_progress")?.c ?? 0;

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

  // Compose the deep briefing from engine outputs + local prior_solutions.
  async assembleBriefing(input: AssembleBriefingInput): Promise<ResearchBriefing> {
    const primaryPaths =
      input.primaryPaths && input.primaryPaths.length > 0
        ? input.primaryPaths
        : input.primaryNodes.map((n) => n.path).filter(Boolean);
    const prior = await this.rankPriorSolutions(input.workspaceId, primaryPaths, 5);
    return assembleBriefingLocal(input, prior);
  }

  // Union: node-owner (node-at-path + ancestors) ∪ context-link memories,
  // node-owner winning duplicates. Local has no per-link confidence column, so context_link
  // confidence is null; owner hits carry 1.0.
  relevantMemoriesForPath(
    workspaceId: string,
    path: string,
    limit = 16,
  ): Promise<RelevantMemoryRow[]> {
    // Ancestor/descendant matching uses a wildcard-free, case-sensitive range
    // (`child > parent||'/'` .. `child < parent||'0'`) instead of LIKE, so `%`/`_`
    // in a stored or queried path are literals and matching is case-sensitive —
    // identical to InMemoryBackend's `startsWith`. (LIKE is case-insensitive in
    // SQLite and would treat those characters as wildcards.)
    const bind = { ws: workspaceId, path };
    const owner = this.db
      .prepare(
        `SELECT m.id AS memory_id, m.node_id AS node_id, m.title AS title
         FROM memories m JOIN nodes n ON n.id = m.node_id
         WHERE m.workspace_id = @ws AND m.status = 'active'
           AND (@path = n.relative_path
             OR (@path > n.relative_path || '/' AND @path < n.relative_path || '0')
             OR @path = '/')`,
      )
      .all(bind) as Array<{ memory_id: string; node_id: string; title: string }>;
    const links = this.db
      .prepare(
        `SELECT m.id AS memory_id, m.node_id AS node_id, m.title AS title, mcp.path AS matched_path
         FROM memory_context_paths mcp JOIN memories m ON m.id = mcp.memory_id
         WHERE m.workspace_id = @ws AND m.status = 'active'
           AND (mcp.path = @path
             OR (@path <> '/' AND @path > mcp.path || '/' AND @path < mcp.path || '0')
             OR (@path <> '/' AND mcp.path > @path || '/' AND mcp.path < @path || '0')
             OR @path = '/')`,
      )
      .all(bind) as Array<{
      memory_id: string;
      node_id: string;
      title: string;
      matched_path: string;
    }>;

    const rows: RelevantMemoryRow[] = [];
    const seen = new Set<string>();
    for (const o of owner) {
      if (seen.has(o.memory_id)) continue;
      seen.add(o.memory_id);
      rows.push({
        memory_id: o.memory_id,
        node_id: o.node_id,
        title: o.title,
        via: "node_owner",
        matched_path: null,
        confidence: 1.0,
      });
    }
    for (const l of links) {
      if (seen.has(l.memory_id)) continue;
      seen.add(l.memory_id);
      rows.push({
        memory_id: l.memory_id,
        node_id: l.node_id,
        title: l.title,
        via: "context_link",
        matched_path: l.matched_path,
        confidence: null,
      });
    }
    return Promise.resolve(rows.slice(0, limit));
  }

  // ── activity ───────────────────────────────────────────────────────────────────
  logActivity(input: LogActivityInput): Promise<ActivityRecord> {
    const id = this.genId();
    const createdAt = this.now();
    const subjects = normalizeActivitySubjects(input.subjects);
    const nodePath = input.nodePath || "/";
    const filesTouched = input.filesTouched ?? { total: 0, by_area: {} };
    const aiClient = input.aiClient ?? "claude-code";
    // Friction counts + applied-memory signals are not stored locally.
    this.db
      .prepare(
        `INSERT INTO activity_logs (id, workspace_id, node_path, domain, action, scope, subjects,
          task_summary, files_touched, ai_client, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        nodePath,
        input.domain,
        input.action,
        input.scope,
        JSON.stringify(subjects),
        input.taskSummary,
        JSON.stringify(filesTouched),
        aiClient,
        createdAt,
      );
    return Promise.resolve({
      id,
      workspaceId: input.workspaceId,
      nodePath,
      domain: input.domain,
      action: input.action,
      scope: input.scope,
      subjects,
      taskSummary: input.taskSummary,
      filesTouched,
      aiClient,
      detailLevel: "standard",
      status: "active",
      createdAt,
    });
  }

  recentActivities(scope: ContextScope, limit: number): Promise<Activity[]> {
    // `rowid DESC` is the insertion-order tiebreaker: created_at alone is ambiguous
    // when rows share a timestamp (a fixed test clock, or sub-millisecond writes),
    // and InMemoryBackend returns newest-inserted-first — so without this the two
    // backends diverge on equal timestamps.
    const rows = this.db
      .prepare(
        "SELECT id, node_path, domain, action, task_summary, created_at FROM activity_logs WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(scope.workspaceId, limit) as Array<Record<string, unknown>>;
    return Promise.resolve(
      rows.map((r) => ({
        id: r["id"] as string,
        nodePath: (r["node_path"] as string | null) ?? null,
        domain: (r["domain"] as string | null) ?? null,
        action: (r["action"] as string | null) ?? null,
        taskSummary: (r["task_summary"] as string | null) ?? null,
        createdAt: r["created_at"] as string,
      })),
    );
  }

  // The router/briefing recent-activity shape (snake_case + node_path + files_touched).
  // Single principal, so the `userId` filter is ignored. files_touched is stored as a
  // JSON string locally; parse it back to its object shape so downstream consumers
  // behave identically across editions.
  recentActivitiesForRouter(
    workspaceId: string,
    limit: number,
    _userId?: string | null,
  ): Promise<RecentActivityForRouter[]> {
    // Contract: this method NEVER throws — the router/briefing degrades to [] on any
    // backend hiccup. A corrupt/locked store must not fail get_context closed.
    // `rowid DESC` ties to insertion order (see recentActivities) for
    // cross-backend determinism.
    try {
      const rows = this.db
        .prepare(
          "SELECT domain, action, task_summary, created_at, node_path, files_touched FROM activity_logs WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        )
        .all(workspaceId, limit) as Array<Record<string, unknown>>;
      return Promise.resolve(
        rows.map((r) => ({
          domain: (r["domain"] as string | null) ?? "",
          action: (r["action"] as string | null) ?? "",
          task_summary: (r["task_summary"] as string | null) ?? "",
          created_at: r["created_at"] as string,
          node_path: (r["node_path"] as string | null) ?? undefined,
          files_touched: parseFilesTouchedJson(r["files_touched"]),
        })),
      );
    } catch {
      return Promise.resolve([]);
    }
  }

  // ── refresh queue ────────────────────────────────────────────────────────────────
  private rowToRefreshEntry(r: Record<string, unknown>): LocalRefreshEntry {
    return {
      id: r["id"] as string,
      workspaceId: r["workspace_id"] as string,
      subjectType: r["subject_type"] as "memory" | "rule",
      subjectId: r["subject_id"] as string,
      kind: (r["kind"] as string | null) ?? "drift",
      reason: (r["reason"] as string | null) ?? "",
      status: r["status"] as RefreshStatus,
      claimedByAi: (r["claimed_by_ai"] as string | null) ?? null,
      claimedAt: (r["claimed_at"] as string | null) ?? null,
      resolvedAt: (r["resolved_at"] as string | null) ?? null,
      resolvedNote: (r["resolved_note"] as string | null) ?? null,
      createdAt: r["created_at"] as string,
      updatedAt: (r["updated_at"] as string | null) ?? (r["created_at"] as string),
    };
  }

  /** Resolve the subject's current title/body/node path so the brief is always fresh. */
  private subjectSnapshot(
    subjectType: "memory" | "rule",
    subjectId: string,
  ): RefreshSubjectSnapshot {
    if (subjectType === "memory") {
      const m = this.db
        .prepare("SELECT title, content, node_id FROM memories WHERE id = ?")
        .get(subjectId) as { title?: string; content?: string; node_id?: string } | undefined;
      const nodePath = m?.node_id
        ? ((
            this.db.prepare("SELECT relative_path FROM nodes WHERE id = ?").get(m.node_id) as
              | { relative_path?: string }
              | undefined
          )?.relative_path ?? "/")
        : "/";
      return { title: m?.title ?? "(unknown)", body: m?.content ?? "", nodePath };
    }
    const r = this.db.prepare("SELECT name, content FROM rules WHERE id = ?").get(subjectId) as
      | { name?: string; content?: string }
      | undefined;
    const nodePath =
      (
        this.db
          .prepare(
            `SELECT n.relative_path AS relative_path FROM node_rules nr
             JOIN nodes n ON n.id = nr.node_id WHERE nr.rule_id = ? LIMIT 1`,
          )
          .get(subjectId) as { relative_path?: string } | undefined
      )?.relative_path ?? "/";
    return { title: r?.name ?? "(unknown)", body: r?.content ?? "", nodePath };
  }

  listPendingRefreshes(
    workspaceId: string,
    includeInProgress?: boolean,
  ): Promise<PendingRefreshSummary[]> {
    const statusClause = includeInProgress
      ? "status IN ('pending','in_progress')"
      : "status = 'pending'";
    const rows = this.db
      .prepare(
        `SELECT * FROM refresh_tasks WHERE workspace_id = ? AND ${statusClause} ORDER BY created_at ASC`,
      )
      .all(workspaceId) as Array<Record<string, unknown>>;
    return Promise.resolve(
      rows.map((r) => {
        const entry = this.rowToRefreshEntry(r);
        return localEntryToSummary(entry, this.subjectSnapshot(entry.subjectType, entry.subjectId));
      }),
    );
  }

  getRefreshBrief(refreshId: string, claimedBy?: string): Promise<RefreshRow> {
    const row = this.db.prepare("SELECT * FROM refresh_tasks WHERE id = ?").get(refreshId) as
      | Record<string, unknown>
      | undefined;
    if (!row) throw new Error(`refresh ${refreshId} not found`);
    let entry = this.rowToRefreshEntry(row);
    // Claim-on-read: pending → in_progress.
    if (entry.status === "pending") {
      const ts = this.now();
      this.db
        .prepare(
          "UPDATE refresh_tasks SET status = 'in_progress', claimed_at = ?, claimed_by_ai = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(ts, claimedBy ?? null, ts, refreshId);
      entry = {
        ...entry,
        status: "in_progress",
        claimedAt: ts,
        claimedByAi: claimedBy ?? null,
        updatedAt: ts,
      };
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
    const ts = this.now();
    const info = this.db
      .prepare(
        `UPDATE refresh_tasks SET status = ?, resolved_at = ?, resolved_note = ?, updated_at = ?,
          claimed_by_ai = COALESCE(?, claimed_by_ai) WHERE id = ?`,
      )
      .run(status, ts, note ?? null, ts, claimedBy ?? null, refreshId);
    if (info.changes === 0) throw new Error(`refresh ${refreshId} not found`);
    const row = this.db
      .prepare("SELECT * FROM refresh_tasks WHERE id = ?")
      .get(refreshId) as Record<string, unknown>;
    const entry = this.rowToRefreshEntry(row);
    // No suggestion mirror / dismissal window / notifications locally.
    return Promise.resolve(
      localEntryToRefreshRow(entry, this.subjectSnapshot(entry.subjectType, entry.subjectId)),
    );
  }

  requestRefresh(input: RequestRefreshInput): Promise<RequestRefreshResult> {
    // Resolve the workspace from the subject (the queue is keyed by a concrete memory/rule).
    const table = input.subjectType === "memory" ? "memories" : "rules";
    const subj = this.db
      .prepare(`SELECT workspace_id FROM ${table} WHERE id = ?`)
      .get(input.subjectId) as { workspace_id?: string } | undefined;
    if (!subj?.workspace_id) throw new Error(`refresh subject ${input.subjectId} not found`);
    // Idempotent per open subject.
    const existing = this.db
      .prepare(
        "SELECT id FROM refresh_tasks WHERE subject_id = ? AND status IN ('pending','in_progress') LIMIT 1",
      )
      .get(input.subjectId) as { id?: string } | undefined;
    if (existing?.id) return Promise.resolve({ refreshId: existing.id, alreadyPending: true });
    const id = this.genId();
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO refresh_tasks
          (id, workspace_id, subject_type, subject_id, kind, reason, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(
        id,
        subj.workspace_id,
        input.subjectType,
        input.subjectId,
        input.kind ?? "drift",
        input.reason,
        ts,
        ts,
      );
    return Promise.resolve({ refreshId: id, alreadyPending: false });
  }

  // Bring-your-own AI route. Delegates to the shared pure adapter: returns
  // null when no PATHRULE_AI_ROUTE_KEY is set (deterministic fallback upstream).
  async routeIntent(input: RouteIntentInput): Promise<RoutingResult | null> {
    return runAiRouteAdapter(input);
  }

  // Bring-your-own semantic search over the local embedding store. `null`
  // ⇒ capability unwired (no key/embed) → get_context omits the field. Otherwise
  // embeds the query, brute-force cosine-scans active memories' stored vectors,
  // and shapes the canonical semantic_candidates payload (degrades to a soft
  // skip on an embedding failure).
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

    const rows = this.db
      .prepare(
        `SELECT e.memory_id AS id, e.dims AS dims, e.embedding AS embedding,
                m.title AS title, COALESCE(n.relative_path, '') AS node_path
           FROM memory_embeddings e
           JOIN memories m ON m.id = e.memory_id AND m.status = 'active'
           LEFT JOIN nodes n ON n.id = m.node_id
          WHERE e.workspace_id = ?`,
      )
      .all(query.workspaceId) as Array<{
      id: string;
      dims: number;
      embedding: Buffer;
      title: string;
      node_path: string;
    }>;

    const scored: ScoredCandidate[] = [];
    for (const row of rows) {
      if (row.dims !== queryEmbedding.dims) continue; // only compare matching models
      const vector = blobToVector(row.embedding, row.dims);
      if (!vector) continue; // truncated / corrupt blob — skip rather than score garbage
      const similarity = cosineSimilarity(queryEmbedding.embedding, vector);
      if (similarity < minSimilarity) continue;
      scored.push({ id: row.id, title: row.title, node_path: row.node_path, similarity });
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
      // True only when an embedding key/seam is wired — the editions matrix
      // --check enforces this stays honest (advertising a capability you can't
      // fill = a lie). BYO embedding key ⇒ first-class local semantic search.
      semantic: this.semanticEnabled,
      // True only when a BYO router key is present (same honesty rule).
      routerLLM: hasAiRouteKey(),
    };
  }
}
