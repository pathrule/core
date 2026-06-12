// SPDX-License-Identifier: Apache-2.0
// Local (no-login) post-init sync.
//
// Performs only the steps a solo dev needs for the offline loop:
//   1. materialize the hook script into PATHRULE_HOME/bin/ (installCliHookScript
//      also registers the hook command path the settings merger writes),
//   2. install the Pre/Post/UserPromptSubmit hook into <cwd>/.claude/settings.json
//      via the pure settings merger,
//   3. write the static `.claude/rules/pathrule-protocol.md` (no backend needed),
//   4. render the per-directory compiled knowledge files (claude-code's
//      CLAUDE.md + .claude/rules/pathrule-knowledge.md, plus the other enabled
//      clients' files) from the LocalBackend — brings the native
//      compilation win to the no-login edition (MCP-less, turn-zero path context),
//   5. warm `~/.pathrule/cache/<ws>/hook-index.json` from the LocalBackend.
//
// No org, no auth, no remote calls, no preflight. Idempotent — every step is
// write-if-changed or a fresh assembly.

import { join } from "node:path";

import { LocalBackend, resolveLocalPrincipal } from "@pathrule/core";
import {
  ensureClaudeSettingsHook,
  renderProtocolRulesFile,
} from "@pathrule/shared/pathrule-protocol.js";
import { rerenderMultiClientLocal } from "@pathrule/shared/client-renderers/pipeline.js";
import { atomicWrite, readIfExists } from "@pathrule/shared/local-runtime/atomic-write.js";
import {
  syncHookIndex,
  type HookIndexSyncResult,
} from "@pathrule/shared/local-runtime/hook-index-writer.js";
import {
  recordManagedFileOwnership,
  type ManagedFileOwner,
} from "@pathrule/shared/local-runtime/managed-file-ownership.js";

import { CLI_VERSION } from "../cli-version.js";
import { installCliHookScript } from "../hook-script-install.js";

const CLI_MANAGED_FILE_OWNER: ManagedFileOwner = "cli";

export interface LocalSyncResult {
  ok: boolean;
  workspace_id: string;
  workspace_root: string;
  hook_script: { ok: boolean; hook_command_path: string | null; error?: string };
  files: {
    written: number;
    skipped: number;
    errors: Array<{ path: string; message: string }>;
  };
  companion: {
    ok: boolean;
    enabled: string[];
    written: number;
    skipped: number;
    removed: number;
    errors: Array<{ path: string; message: string }>;
    error?: string;
  };
  hook_index: HookIndexSyncResult;
  error?: string;
}

export interface LocalSyncOptions {
  /** Override the embedded hook script source (tests only). */
  hookScriptSource?: string;
}

export async function syncLocalWorkspace(
  env: NodeJS.ProcessEnv,
  cwd: string,
  workspaceId: string,
  opts: LocalSyncOptions = {},
): Promise<LocalSyncResult> {
  const files: LocalSyncResult["files"] = { written: 0, skipped: 0, errors: [] };
  const ownedPaths = new Set<string>();

  // 1. Hook script first — it registers the command path the settings merger
  // serializes into .claude/settings.json.
  let hookScript: LocalSyncResult["hook_script"];
  try {
    const installed = await installCliHookScript(
      env,
      opts.hookScriptSource === undefined ? {} : { scriptSource: opts.hookScriptSource },
    );
    hookScript = { ok: true, hook_command_path: installed.hookCommandPath };
  } catch (err) {
    hookScript = {
      ok: false,
      hook_command_path: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. .claude/settings.json hook (only when the script actually landed — a
  // settings entry pointing at a missing script would break every tool call).
  const settingsPath = ".claude/settings.json";
  if (hookScript.ok) {
    try {
      const absolute = join(cwd, settingsPath);
      const existing = await readIfExists(absolute);
      const { body, changed } = ensureClaudeSettingsHook(existing);
      if (changed) {
        await atomicWrite(absolute, body);
        files.written += 1;
      } else {
        files.skipped += 1;
      }
      ownedPaths.add(settingsPath);
    } catch (err) {
      files.errors.push({
        path: settingsPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 3. Static protocol rules file (backend-free render).
  const protocolPath = ".claude/rules/pathrule-protocol.md";
  try {
    const absolute = join(cwd, protocolPath);
    const body = renderProtocolRulesFile();
    const existing = await readIfExists(absolute);
    if (existing === body) {
      files.skipped += 1;
    } else {
      await atomicWrite(absolute, body);
      files.written += 1;
    }
    ownedPaths.add(protocolPath);
  } catch (err) {
    files.errors.push({
      path: protocolPath,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await recordManagedFileOwnership({
      workspaceRoot: cwd,
      paths: Array.from(ownedPaths),
      owner: CLI_MANAGED_FILE_OWNER,
      ownerVersion: CLI_VERSION,
    });
  } catch (err) {
    files.errors.push({
      path: ".pathrule/managed-files.json",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 4 + 5 share one LocalBackend handle: render the per-directory compiled
  // knowledge files, then warm the offline hook-index from the same store.
  let companion: LocalSyncResult["companion"];
  let hookIndex: HookIndexSyncResult;
  const backend = LocalBackend.openForWorkspace(workspaceId, env);
  try {
    const outcome = await rerenderMultiClientLocal({
      backend,
      workspaceId,
      workspaceName: backend.getWorkspaceName(workspaceId) ?? workspaceId,
      workspaceRoot: cwd,
      userId: resolveLocalPrincipal(env),
      runtimeOwner: CLI_MANAGED_FILE_OWNER,
      runtimeVersion: CLI_VERSION,
    });
    companion = {
      ok: outcome.ok,
      enabled: outcome.enabled,
      written: outcome.disk.written,
      skipped: outcome.disk.skipped,
      removed: outcome.disk.removed,
      errors: outcome.disk.errors,
      error: outcome.error,
    };
  } catch (err) {
    companion = {
      ok: false,
      enabled: [],
      written: 0,
      skipped: 0,
      removed: 0,
      errors: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    hookIndex = await syncHookIndex({
      backend,
      workspaceId,
      workspaceRoot: cwd,
      env,
    });
  } catch (err) {
    hookIndex = {
      ok: false,
      path: null,
      refreshed_episodes: false,
      schema_version: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    backend.close();
  }

  const ok =
    hookScript.ok && files.errors.length === 0 && companion.ok && hookIndex.ok;
  return {
    ok,
    workspace_id: workspaceId,
    workspace_root: cwd,
    hook_script: hookScript,
    files,
    companion,
    hook_index: hookIndex,
    error: ok
      ? undefined
      : !hookScript.ok
        ? "hook_script_install_failed"
        : files.errors.length > 0
          ? "local_file_sync_failed"
          : !companion.ok
            ? "companion_render_failed"
            : "hook_index_sync_failed",
  };
}
