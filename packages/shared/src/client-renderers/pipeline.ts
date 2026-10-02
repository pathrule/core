// End-to-end "rerender every enabled non-Claude client's files" helper.
// Lives here so both the Electron post-write hook and the MCP server's
// `rerenderClaudeMdAfterWrite` can call the same code path without
// duplicating the gather → resolve enabled → render → write dance.
//
// Node-only: imports from `./disk-writer.js` which uses fs.

import type { KnowledgeBackend } from "@pathrule/core";
import { renderTeamContextBlock } from "./team-context-block.js";

import type { AgentTargetId } from "../skills/agent-targets.js";
import {
  STUDIO_ENGINE_IDS,
  detectClientsOnDisk,
  resolveEnabledClients,
} from "../skills/disk-detection.js";
import { DEFAULT_ACTIVE_AGENT_TARGETS } from "../skills/agent-targets.js";
import type { ManagedFileOwner } from "../local-runtime/managed-file-ownership.js";

import {
  gatherLocalMultiClientInput,
  renderForClients,
  type ClientRenderResult,
} from "./orchestrator.js";
import { writeMultiClientFiles, type DiskWriteResult } from "./disk-writer.js";
import { sweepPathruleOwnLeftovers } from "./legacy-sweep.js";
import {
  resolveWorkspaceProtocolChannel,
  type WorkspaceProtocolChannel,
} from "./protocol-channel-fs.js";
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
  /**
   * The protocol-channel decision this render used, returned so the caller hands
   * the SAME one to syncHookIndex. The two writers disagreeing is the only
   * failure mode that loses the protocol entirely, so the decision travels with
   * the render instead of being taken twice.
   */
  protocolChannel?: WorkspaceProtocolChannel;
  /**
   * The rendered team-context block, present only when this render was in
   * signature mode — i.e. exactly when the compiled file that used to carry it
   * was not written. Returned for the same reason as `protocolChannel`: the
   * caller hands it to syncHookIndex, so the file half and the index half of one
   * decision cannot disagree.
   */
  teamContext?: string;
  /**
   * What the one-time legacy sweep removed, and what it left for the user.
   * Present only on the sync that actually ran it (once per workspace per
   * process). Reported so a deletion in the user's tree is never silent.
   */
  legacySweep?: { removed: string[]; held: string[] };
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
  /**
   * Engines Studio can run for this workspace. Defaults to every Studio engine,
   * because an engine that is launchable must receive knowledge whether or not
   * its companion target was ticked in settings. Pass a narrower list from a
   * non-Studio caller (CLI, MCP) that knows no engine is running.
   */
  activeEngines?: readonly string[];
  /**
   * Process env, read only for the signature-mode rollout switch. Omitted falls
   * back to `process.env`, which is what every real caller wants; tests pass it
   * explicitly so the switch is never ambient.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Resolve the protocol channel for this render, and return the decision.
   *
   * OFF by default, and that default is a safety property rather than caution.
   * The decision has two halves: this render writes the files, and the caller
   * must hand the same decision to `syncHookIndex`. A caller that renders with a
   * signature but never passes the protocol on produces a workspace where the
   * protocol reaches the agent through NO channel. So a caller opts in only once
   * it carries both halves.
   */
  resolveChannel?: boolean;
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
      // A Studio-launched engine must receive knowledge regardless of which
      // tools were ticked in settings.
      activeEngines: args.activeEngines ?? STUDIO_ENGINE_IDS,
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
    const protocolChannel = args.resolveChannel
      ? await resolveWorkspaceProtocolChannel({
          workspaceRoot: args.workspaceRoot,
          enabled: targets,
          env: args.env,
        })
      : undefined;
    // Deliberately NOT gated on signature mode: these leftovers are the residue
    // of a fixed bug, not part of the new channel, and expecting the user to run
    // eject to clean up after us is a chore we invented for them.
    const sweep = await sweepPathruleOwnLeftovers(args.workspaceRoot);
    const results = renderForClients(input, targets, {
      protocolOnHook: protocolChannel?.signatureClients,
    });
    const disk = await writeMultiClientFiles({
      workspaceRoot: args.workspaceRoot,
      results,
      sweepFor: targets,
      runtimeOwner: args.runtimeOwner,
      runtimeVersion: args.runtimeVersion,
    });
    return {
      ok: true,
      enabled,
      results,
      disk,
      protocolChannel,
      teamContext:
        protocolChannel && protocolChannel.signatureClients.length > 0
          ? (renderTeamContextBlock(input.teamContext) ?? undefined)
          : undefined,
      legacySweep: sweep.ran ? { removed: sweep.removed, held: sweep.held } : undefined,
    };
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
