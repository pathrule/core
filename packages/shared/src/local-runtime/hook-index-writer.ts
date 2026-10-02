// The local hook-index writer, shared by the CLI (`pathrule sync` / init) and the
// local MCP runtime. It assembles the hook payload from a KnowledgeBackend (hosted
// service or local SQLite) and writes it to `<PATHRULE_HOME>/cache/<wsId>/hook-index.json`
// — the exact file `pathrule-hook.js` reads on PreToolUse/PostToolUse/UserPromptSubmit.
// This is what makes path-scoped context injection work OFFLINE: no daemon, no network,
// just the local store.
//
// Backend-agnostic by construction (takes KnowledgeBackend), so the hosted path is
// unchanged — it's the same assembly used in either edition.

import type { AffinityPayload, EmbeddingsPayload, KnowledgeBackend, Warehouse } from "@pathrule/core";
// Value import, and safe here: this module is Node-only (it writes files), so
// pulling in the node:crypto-backed assembler cannot reach a browser bundle.
import { assembleWarehouse } from "@pathrule/core/backend/hook-index.js";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localRuntimePaths } from "./paths.js";
import type { HookIndex, KnowledgeGapStub } from "../hook-supervisor/types.js";
import { knowledgeGapStubsForIndex } from "../knowledge-map/gap-index.js";
import type { GuidanceEntry } from "../user-intelligence/oversight-map.js";

const EPISODE_REFRESH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const EPISODE_REFRESH_MIN_INTERVAL_MS = 60_000;
const lastEpisodeRefreshAt = new Map<string, number>();

export interface HookIndexSyncResult {
  ok: boolean;
  path: string | null;
  refreshed_episodes: boolean;
  schema_version: number | null;
  error?: string;
}

export async function syncHookIndex(args: {
  backend: KnowledgeBackend;
  workspaceId: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  refreshEpisodes?: boolean;
  /**
   * Cloud semantic endpoint to stamp into the index, so the hook can rank bodies
   * over our own embedding infrastructure instead of falling back to keyword
   * overlap. Pass it ONLY from a cloud-backed caller: absence is what keeps the
   * local/OSS edition on its BYO-key path, and it is not read from `env` because
   * the MCP server resolves these from build-time constants where process.env is
   * empty (see mcp-server/src/env.ts).
   */
  cloud?: { url: string; anonKey: string };
  /**
   * Rendered agent protocol, stamped onto the index so the hook delivers it once
   * per session instead of the companion files carrying it.
   *
   * Never decided here: the caller passes it only when
   * `resolveProtocolChannel(...).protocolOnIndex` is true, so the file half and
   * the index half of that decision cannot disagree. Blank or omitted leaves the
   * field off the index, which is what keeps the hook silent about it.
   */
  protocol?: string;
  /**
   * Compiled USER preference entries: how the PERSON works, already decided by the user-intelligence
   * layer (eligible, in scope, rendered, with the terms that make each relevant).
   *
   * Passed in rather than read here for the same reason `protocol` is: the caller owns the decision,
   * and the index is only the channel. The hook may not import anything, so nothing about this layer
   * can live there; it matches terms against the prompt and carries the line, and that is all.
   */
  userPreferences?: Array<{ id: string; line: string; terms: string[]; always: boolean; min?: number; relaxes?: boolean }>;
  /**
   * Oversight and expertise-lease entries (`turn-guidance.ts`), passed in for the same reason: the
   * caller owns the decision. Each is a rendered line under its own heading, matched by risk terms.
   */
  guidance?: GuidanceEntry[];
  /**
   * Rendered team context block, travelling with the protocol for the same
   * reason: in signature mode the compiled file that used to carry it is not
   * written, so the hook is its only remaining channel. Same discipline as
   * `protocol` — the caller passes it only alongside a signature-mode decision,
   * and omitting it leaves the field off the index.
   */
  teamContext?: string;
  /** Explicit gap stubs (tests); omitted, the writer computes them when delivery is on. */
  knowledgeGaps?: KnowledgeGapStub[];
}): Promise<HookIndexSyncResult> {
  const target = hookIndexPath(args.env, args.workspaceId);
  let refreshedEpisodes = false;

  // Refresh via the backend (hosted: managed service; local: SQLite assembly).
  if (args.refreshEpisodes !== false && shouldRefreshEpisodes(args.workspaceId)) {
    const now = Date.now();
    try {
      const r = await args.backend.refreshWorkEpisodes(
        args.workspaceId,
        new Date(now - EPISODE_REFRESH_WINDOW_MS).toISOString(),
      );
      refreshedEpisodes = r.ok;
    } catch {
      refreshedEpisodes = false;
    }
  }

  let data: HookIndex | null;
  try {
    data = await args.backend.buildHookIndexPayload(args.workspaceId);
  } catch (err) {
    return {
      ok: false,
      path: target,
      refreshed_episodes: refreshedEpisodes,
      schema_version: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!data || typeof data !== "object") {
    return {
      ok: false,
      path: target,
      refreshed_episodes: refreshedEpisodes,
      schema_version: null,
      error: "empty_hook_index_payload",
    };
  }

  const index: HookIndex = {
    ...data,
    workspace_root: args.workspaceRoot,
  };

  // Only stamped when the caller is cloud-backed, and only when both halves are
  // present: a half-written endpoint would make the hook spawn a request that
  // cannot succeed, and its failure looks exactly like "no key" from the outside.
  if (args.cloud?.url && args.cloud.anonKey) {
    index.cloud_semantic = { url: args.cloud.url, anon_key: args.cloud.anonKey };
  }

  if (typeof args.protocol === "string" && args.protocol.trim().length > 0) {
    index.protocol = args.protocol;
  }

  // Omitted entirely when there is nothing to carry, so a person with no learned preferences costs the
  // hook nothing and the index stays byte-identical to what it was before this layer existed.
  if (Array.isArray(args.userPreferences) && args.userPreferences.length > 0) {
    index.user_preferences = args.userPreferences;
  }

  if (Array.isArray(args.guidance) && args.guidance.length > 0) {
    index.guidance = args.guidance;
  }

  // Same channel, same condition: present only when the workspace's companion
  // files are in signature mode, because that is exactly when the compiled file
  // that used to carry this block is no longer written.
  if (typeof args.teamContext === "string" && args.teamContext.trim().length > 0) {
    index.team_context = args.teamContext;
  }

  // Open knowledge gaps, decided here rather than by each caller because the whole file
  // is rewritten on every sync and a caller that forgot the field would erase it. Empty (and so
  // absent, keeping the index byte-identical) unless knowledgeGapDelivery is on.
  const knowledgeGaps =
    args.knowledgeGaps ??
    (await knowledgeGapStubsForIndex({
      backend: args.backend,
      workspaceId: args.workspaceId,
      workspaceRoot: args.workspaceRoot,
      env: args.env,
    }));
  if (knowledgeGaps.length > 0) index.knowledge_gaps = knowledgeGaps;

  // Native Knowledge Compilation: when the backend can compile knowledge into
  // native instruction files, mark the index so the hook stops carrying memory
  // content on PreToolUse (turn-zero files own that now) and knows which
  // memory ids are already delivered.
  if (typeof args.backend.buildKnowledgePayload === "function") {
    try {
      // FULL payload drives compiled_memory_ids (unchanged): clients whose file
      // carries bodies (codex/cursor/...) skip these in delta injection exactly
      // as before. SLIM payload drives the router ids for clients with a
      // prompt-time body channel (Claude): title-indexed memories are eligible
      // for hook top-k, and rule bodies already sit in the slim file.
      const [knowledge, slim] = await Promise.all([
        args.backend.buildKnowledgePayload(args.workspaceId),
        args.backend.buildKnowledgePayload(args.workspaceId, "slim"),
      ]);
      if (knowledge && knowledge.length > 0) {
        index.knowledge_compiled = true;
        index.compiled_memory_ids = [...new Set(knowledge.flatMap((n) => n.memory_ids))].sort();
      }
      if (slim && slim.length > 0) {
        index.indexed_memory_ids = [
          ...new Set(slim.flatMap((n) => n.indexed_memory_ids ?? [])),
        ].sort();
        index.compiled_rule_ids = [...new Set(slim.flatMap((n) => n.rule_ids))].sort();
      }
    } catch {
      /* knowledge compilation is non-fatal for hook-index sync */
    }
  }

  await writeHookIndex(args.env, index);

  // Persist the full-body warehouse next to the index. Best-effort — the
  // index write already succeeded, and warehouse is an optimization the hook
  // reads selectively by id for delta delivery.
  //
  // Two producers, because not every backend can run the assembler. LocalBackend and
  // in-memory implement buildWarehousePayload directly; CloudBackend cannot (the
  // assembler imports node:crypto and CloudBackend reaches the renderer bundle), so it
  // returns the raw input via buildHookInputPayload and we assemble here — this module
  // is Node-only. Before this existed, cloud simply wrote no warehouse and the hook's
  // loadWarehouse returned {}, quietly degrading body delta delivery to previews.
  try {
    let warehouse: Warehouse | null = null;
    if (typeof args.backend.buildWarehousePayload === "function") {
      warehouse = await args.backend.buildWarehousePayload(args.workspaceId);
    } else if (typeof args.backend.buildHookInputPayload === "function") {
      warehouse = assembleWarehouse(await args.backend.buildHookInputPayload(args.workspaceId));
    }
    if (warehouse) await writeWarehouse(args.env, args.workspaceId, warehouse);
  } catch {
    /* warehouse is non-fatal */
  }

  // Persist precomputed embedding vectors next to the warehouse. Best-effort
  // — absent (no key/store) ⇒ the hook ranks lexically. Never blocks the sync.
  if (typeof args.backend.buildEmbeddingsPayload === "function") {
    try {
      const embeddings = await args.backend.buildEmbeddingsPayload(args.workspaceId);
      if (embeddings) await writeEmbeddings(args.env, args.workspaceId, embeddings);
    } catch {
      /* embeddings are a ranking optimization, never load-bearing */
    }
  }

  // Learned affinity weights, same discipline as embeddings: a ranking optimization the
  // hook can live without. Written separately from embeddings.json so a workspace with
  // vectors but no affinity history (or the reverse) still gets what it has.
  if (typeof args.backend.buildAffinityPayload === "function") {
    try {
      const affinity = await args.backend.buildAffinityPayload(args.workspaceId);
      if (affinity) await writeAffinity(args.env, args.workspaceId, affinity);
    } catch {
      /* affinity only reorders candidates; never load-bearing */
    }
  }

  return {
    ok: true,
    path: target,
    refreshed_episodes: refreshedEpisodes,
    schema_version: index.schema_version,
  };
}

function warehousePath(env: NodeJS.ProcessEnv, workspaceId: string): string {
  return join(localRuntimePaths(env).home, "cache", workspaceId, "warehouse.json");
}

async function writeWarehouse(
  env: NodeJS.ProcessEnv,
  workspaceId: string,
  warehouse: Warehouse,
): Promise<void> {
  const target = warehousePath(env, workspaceId);
  await mkdir(join(localRuntimePaths(env).home, "cache", workspaceId), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(warehouse, null, 2), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

function embeddingsPath(env: NodeJS.ProcessEnv, workspaceId: string): string {
  return join(localRuntimePaths(env).home, "cache", workspaceId, "embeddings.json");
}

async function writeEmbeddings(
  env: NodeJS.ProcessEnv,
  workspaceId: string,
  embeddings: EmbeddingsPayload,
): Promise<void> {
  const target = embeddingsPath(env, workspaceId);
  await mkdir(join(localRuntimePaths(env).home, "cache", workspaceId), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(embeddings), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

function affinityPath(env: NodeJS.ProcessEnv, workspaceId: string): string {
  return join(localRuntimePaths(env).home, "cache", workspaceId, "affinity.json");
}

async function writeAffinity(
  env: NodeJS.ProcessEnv,
  workspaceId: string,
  affinity: AffinityPayload,
): Promise<void> {
  const target = affinityPath(env, workspaceId);
  await mkdir(join(localRuntimePaths(env).home, "cache", workspaceId), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(affinity), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}

function shouldRefreshEpisodes(workspaceId: string): boolean {
  const now = Date.now();
  const last = lastEpisodeRefreshAt.get(workspaceId) ?? 0;
  if (now - last < EPISODE_REFRESH_MIN_INTERVAL_MS) return false;
  lastEpisodeRefreshAt.set(workspaceId, now);
  return true;
}

function hookIndexPath(env: NodeJS.ProcessEnv, workspaceId: string): string {
  return join(localRuntimePaths(env).home, "cache", workspaceId, "hook-index.json");
}

async function writeHookIndex(env: NodeJS.ProcessEnv, index: HookIndex): Promise<void> {
  const target = hookIndexPath(env, index.workspace_id);
  await mkdir(join(localRuntimePaths(env).home, "cache", index.workspace_id), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(index, null, 2), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}
