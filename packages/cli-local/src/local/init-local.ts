// SPDX-License-Identifier: Apache-2.0
// Local (no-login) workspace init.
//
// `pathrule init --local` creates a workspace and binds it to the current
// folder: it stands up the SQLite store at `~/.pathrule/<id>/pathrule.db` and
// registers the folder as its root so `discoverWorkspaceForCwd` can map a cwd
// back to it. Hooks + AI-tool MCP wiring are left to `setup --local`.
//
// Idempotent: if a local workspace already covers this cwd, we reuse it instead
// of creating a duplicate store.

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { LocalBackend } from "@pathrule/core";
import { syncHookIndex } from "@pathrule/shared/local-runtime/hook-index-writer.js";
// Deep import, NOT the barrel. This file is inside the OSS export closure, and the
// closure is the full import graph: one barrel import re-exports auth, billing,
// cloud-connector and intelligence into it, which is 25 closure violations and a
// failing `release:security-gates` for the sake of one function.
import { errorMessage } from "@pathrule/shared/net/failure-class.js";

export interface InitLocalResult {
  workspaceId: string;
  name: string;
  localRootPath: string;
  /** "created" a new store, or "exists" when a local workspace already covered the cwd. */
  action: "created" | "exists";
}

export interface InitLocalOptions {
  cwd: string;
  name?: string;
  env?: NodeJS.ProcessEnv;
  /** Test seam — defaults to randomUUID. */
  genWorkspaceId?: () => string;
}

function defaultLocalWorkspaceName(cwd: string): string {
  return basename(cwd.replace(/\/+$/, "")) || "workspace";
}

export async function initLocalWorkspace(options: InitLocalOptions): Promise<InitLocalResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd.replace(/\/+$/, "");

  // Idempotent — a folder already inside a local workspace reuses it.
  const existing = LocalBackend.discoverWorkspaceForCwd(cwd, env);
  if (existing) {
    return {
      workspaceId: existing.workspaceId,
      name: options.name ?? defaultLocalWorkspaceName(existing.localRootPath),
      localRootPath: existing.localRootPath,
      action: "exists",
    };
  }

  const workspaceId = (options.genWorkspaceId ?? (() => randomUUID()))();
  const name = options.name ?? defaultLocalWorkspaceName(cwd);
  const backend = LocalBackend.openForWorkspace(workspaceId, env);
  try {
    backend.registerWorkspace({ workspaceId, name, localRootPath: cwd });
    // Warm the offline hook-index so PreToolUse/UserPromptSubmit inject path context
    // from the very first prompt (no daemon locally). Best-effort — init must not fail on it,
    // but it must not be SILENT either: syncHookIndex REPORTS failure via { ok: false, error }
    // and only throws on a genuine disk error, so a bare .catch() left the most likely
    // failure invisible and the first prompts uninjected with no trace.
    await syncHookIndex({ backend, workspaceId, workspaceRoot: cwd, env })
      .then((result) => {
        if (!result.ok) {
          process.stderr.write(
            `[pathrule] hook-index warm-up reported failure: ${result.error ?? "no payload returned"}\n`,
          );
        }
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `[pathrule] hook-index warm-up threw: ${errorMessage(err, "unknown error")}\n`,
        );
      });
  } finally {
    backend.close();
  }
  return { workspaceId, name, localRootPath: cwd, action: "created" };
}
