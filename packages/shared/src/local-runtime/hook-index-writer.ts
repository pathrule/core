// The local hook-index writer, shared by the CLI (`pathrule sync` / init) and the
// local MCP runtime. It assembles the hook payload from a KnowledgeBackend (hosted
// service or local SQLite) and writes it to `<PATHRULE_HOME>/cache/<wsId>/hook-index.json`
// — the exact file `pathrule-hook.js` reads on PreToolUse/PostToolUse/UserPromptSubmit.
// This is what makes path-scoped context injection work OFFLINE: no daemon, no network,
// just the local store.
//
// Backend-agnostic by construction (takes KnowledgeBackend), so the hosted path is
// unchanged — it's the same assembly used in either edition.

import type { EmbeddingsPayload, KnowledgeBackend, Warehouse } from "@pathrule/core";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localRuntimePaths } from "./paths.js";
import type { HookIndex } from "../hook-supervisor/types.js";

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
  if (typeof args.backend.buildWarehousePayload === "function") {
    try {
      const warehouse = await args.backend.buildWarehousePayload(args.workspaceId);
      if (warehouse) await writeWarehouse(args.env, args.workspaceId, warehouse);
    } catch {
      /* warehouse is non-fatal */
    }
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
