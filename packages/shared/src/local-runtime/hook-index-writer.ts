// The local hook-index writer, shared by the CLI (`pathrule sync` / init) and the
// local MCP runtime. It assembles the hook payload from a KnowledgeBackend (hosted
// service or local SQLite) and writes it to `<PATHRULE_HOME>/cache/<wsId>/hook-index.json`
// — the exact file `pathrule-hook.js` reads on PreToolUse/PostToolUse/UserPromptSubmit.
// This is what makes path-scoped context injection work OFFLINE: no daemon, no network,
// just the local store.
//
// Backend-agnostic by construction (takes KnowledgeBackend), so the hosted path is
// unchanged — it's the same assembly used in either edition.

import type { KnowledgeBackend } from "@pathrule/core";
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

  await writeHookIndex(args.env, index);

  return {
    ok: true,
    path: target,
    refreshed_episodes: refreshedEpisodes,
    schema_version: index.schema_version,
  };
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
