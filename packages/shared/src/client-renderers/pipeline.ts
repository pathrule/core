// End-to-end "rerender every enabled non-Claude client's files" helper.
// Lives here so both the Electron post-write hook and the MCP server's
// `rerenderClaudeMdAfterWrite` can call the same code path without
// duplicating the gather → resolve enabled → render → write dance.
//
// Node-only: imports from `./disk-writer.js` which uses fs.

import type { KnowledgeBackend } from "@pathrule/core";

import type { AgentTargetId } from "../skills/agent-targets.js";
import { detectClientsOnDisk, resolveEnabledClients } from "../skills/disk-detection.js";
import { DEFAULT_ACTIVE_AGENT_TARGETS } from "../skills/agent-targets.js";
import type { ManagedFileOwner } from "../local-runtime/managed-file-ownership.js";

import {
  gatherLocalMultiClientInput,
  renderForClients,
  type ClientRenderResult,
} from "./orchestrator.js";
import { writeMultiClientFiles, type DiskWriteResult } from "./disk-writer.js";
import type { MultiClientInput } from "./types.js";

// Historically only non-Claude clients flowed through this pipeline (the root
// CLAUDE.md has its own bespoke writer). With Native Knowledge Compilation,
// `claude-code` joins for its KNOWLEDGE-ONLY renderer (per-directory CLAUDE.md
// + .claude/rules/pathrule-knowledge.md) — the root CLAUDE.md still never
// renders here.
const RENDER_TARGETS: AgentTargetId[] = ["claude-code", "cursor", "codex", "windsurf"];

/** A single changed content item, used to scope an incremental re-render. */
export interface ChangedEntity {
  kind: "memory" | "rule" | "skill";
  id: string;
}

/**
 * Filter the gathered input down to the directory that owns `entity` (plus the
 * root "/" node, so every client keeps its turn-zero root knowledge section),
 * and report whether the orphan sweep should run. Returns the input untouched
 * with `sweep: true` when there is no entity, no compiled knowledge, or the
 * entity matches no node — i.e. a full, sweeping render.
 */
export function scopeToEntity(
  input: MultiClientInput,
  entity: ChangedEntity | undefined,
): { input: MultiClientInput; sweep: boolean } {
  if (!entity || !input.knowledge || input.knowledge.length === 0) {
    return { input, sweep: true };
  }
  const idField =
    entity.kind === "memory" ? "memory_ids" : entity.kind === "rule" ? "rule_ids" : "skill_ids";
  const matchedDirs = new Set(
    input.knowledge.filter((n) => n[idField].includes(entity.id)).map((n) => n.dir_path),
  );
  if (matchedDirs.size === 0) {
    // Entity not in the compiled set (deleted / truncated) — full render.
    return { input, sweep: true };
  }
  // Always keep the root node so non-Claude clients retain their root section.
  matchedDirs.add("/");
  const knowledge = input.knowledge.filter((n) => matchedDirs.has(n.dir_path));
  return { input: { ...input, knowledge }, sweep: false };
}

export interface RerenderOutcome {
  ok: boolean;
  enabled: AgentTargetId[];
  results: ClientRenderResult[];
  disk: DiskWriteResult;
  error?: string;
}

export interface RerenderLocalArgs {
  /** SQLite-backed LocalBackend — the only data source in local mode. */
  backend: KnowledgeBackend;
  workspaceId: string;
  /** Display title for the companion files (LocalBackend.getWorkspaceName). */
  workspaceName: string;
  workspaceRoot: string;
  /** Local principal id stamped into reads. */
  userId: string;
  runtimeOwner?: ManagedFileOwner;
  runtimeVersion?: string;
}

/**
 * Local (no-login) twin of {@link rerenderMultiClient}: renders the per-directory
 * compiled knowledge files (claude-code's CLAUDE.md + .claude/rules/pathrule-knowledge.md,
 * plus the other clients' files) entirely from the LocalBackend — no Supabase.
 * Enabled clients are resolved from disk detection + the default fallback (the
 * cloud `selected_ai_clients` table has no local equivalent). Best-effort —
 * never throws; knowledge files are an enhancement, not load-bearing for sync.
 */
export async function rerenderMultiClientLocal(args: RerenderLocalArgs): Promise<RerenderOutcome> {
  const empty: DiskWriteResult = { written: 0, skipped: 0, removed: 0, backedUp: [], errors: [] };
  try {
    const detected = await detectClientsOnDisk(args.workspaceRoot);
    const enabled = resolveEnabledClients({
      selected: null,
      detected,
      fallback: DEFAULT_ACTIVE_AGENT_TARGETS,
    });
    const targets = enabled.filter((c) => RENDER_TARGETS.includes(c));
    if (targets.length === 0) {
      return { ok: true, enabled, results: [], disk: empty };
    }

    const input = await gatherLocalMultiClientInput({
      backend: args.backend,
      workspaceId: args.workspaceId,
      workspaceName: args.workspaceName,
      userId: args.userId,
    });
    const results = renderForClients(input, targets);
    const disk = await writeMultiClientFiles({
      workspaceRoot: args.workspaceRoot,
      results,
      sweepFor: targets,
      runtimeOwner: args.runtimeOwner,
      runtimeVersion: args.runtimeVersion,
    });
    return { ok: true, enabled, results, disk };
  } catch (err) {
    return {
      ok: false,
      enabled: [],
      results: [],
      disk: empty,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
