// SPDX-License-Identifier: Apache-2.0
// After syncLocalWorkspace runs in a temp PATHRULE_HOME + cwd, the hook script,
// the .claude/settings.json hook block, the static protocol rules file, and
// cache/<wsId>/hook-index.json all exist.

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@pathrule/core";
import { initLocalWorkspace } from "./init-local.js";
import { syncLocalWorkspace } from "./sync-local.js";

const HOOK_SCRIPT_SOURCE = "#!/usr/bin/env node\n// pathrule-hook test body\n";

describe("syncLocalWorkspace", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps) rmSync(d, { recursive: true, force: true });
    tmps.length = 0;
  });

  function freshDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tmps.push(dir);
    return dir;
  }

  it("installs the hook script, settings hook, protocol file, and hook-index — no login", async () => {
    const home = freshDir("pathrule-cli-home-");
    const cwd = freshDir("pathrule-cli-ws-");
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;

    const ws = await initLocalWorkspace({ cwd, env, genWorkspaceId: () => "ws-sync-local" });
    const result = await syncLocalWorkspace(env, cwd, ws.workspaceId, {
      hookScriptSource: HOOK_SCRIPT_SOURCE,
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.workspace_id).toBe("ws-sync-local");
    expect(result.workspace_root).toBe(cwd);

    // 1. Hook script materialized into PATHRULE_HOME/bin and registered.
    const scriptPath = join(home, "bin", "pathrule-hook.js");
    expect(result.hook_script.ok).toBe(true);
    expect(result.hook_script.hook_command_path).toBe(scriptPath);
    expect(readFileSync(scriptPath, "utf8")).toBe(HOOK_SCRIPT_SOURCE);

    // 2. .claude/settings.json carries the Pathrule hook set pointing at it.
    const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf8")) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const event of ["PreToolUse", "PostToolUse", "UserPromptSubmit"]) {
      const entries = settings.hooks?.[event] ?? [];
      expect(
        entries.some((entry) => entry.hooks.some((h) => h.command.includes(scriptPath))),
        `${event} hook should reference the installed script`,
      ).toBe(true);
    }

    // 3. Signature mode (default since 2026-09-01): the protocol is NOT a file in
    //    the user's repo any more. The hook delivers it, so the file must be
    //    absent — and its absence is only safe because the index carries it, which
    //    is asserted right below. Checking one without the other is how a
    //    workspace ends up with no protocol anywhere.
    expect(existsSync(join(cwd, ".claude/rules/pathrule-protocol.md"))).toBe(false);

    // 4. Offline hook-index warmed from the local store — and carrying the protocol.
    expect(result.hook_index.ok).toBe(true);
    const index = JSON.parse(
      readFileSync(join(home, "cache", "ws-sync-local", "hook-index.json"), "utf8"),
    ) as { workspace_id?: string; workspace_root?: string; protocol?: string };
    expect(index.workspace_id).toBe("ws-sync-local");
    expect(index.workspace_root).toBe(cwd);
    expect(index.protocol, "the hook index must carry what the file stopped carrying").toContain(
      "Pathrule",
    );

    // Managed-file ownership recorded for repair/uninstall.
    expect(existsSync(join(cwd, ".pathrule/managed-files.json"))).toBe(true);
  });

  it("renders the per-directory compiled knowledge files from the local store — no login", async () => {
    const home = freshDir("pathrule-cli-home-");
    const cwd = freshDir("pathrule-cli-ws-");
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;

    const ws = await initLocalWorkspace({ cwd, env, genWorkspaceId: () => "ws-knowledge" });

    // Seed knowledge: a root-scoped memory + a path-scoped one under /src.
    const backend = LocalBackend.openForWorkspace(ws.workspaceId, env);
    try {
      const root = await backend.ensureNodeForPath(ws.workspaceId, "/");
      await backend.writeMemory({
        workspaceId: ws.workspaceId,
        nodeId: root.id,
        title: "Root convention",
        content: "Always run pnpm typecheck before committing.",
      });
      const src = await backend.ensureNodeForPath(ws.workspaceId, "/src");
      await backend.writeMemory({
        workspaceId: ws.workspaceId,
        nodeId: src.id,
        title: "Src module rule",
        content: "Components live under src and export via index.ts.",
      });
    } finally {
      backend.close();
    }

    const result = await syncLocalWorkspace(env, cwd, ws.workspaceId, {
      hookScriptSource: HOOK_SCRIPT_SOURCE,
    });

    expect(result.ok).toBe(true);
    expect(result.companion.ok).toBe(true);

    // Signature mode: knowledge no longer becomes files in the user's repo. This
    // test used to assert the opposite — root knowledge into
    // .claude/rules/pathrule-knowledge.md and path knowledge into src/CLAUDE.md.
    // Users asked us to stop writing into their checkout, and the hook delivers
    // the same knowledge per prompt instead, selected rather than loaded whole.
    expect(existsSync(join(cwd, ".claude/rules/pathrule-knowledge.md"))).toBe(false);
    expect(existsSync(join(cwd, "src/CLAUDE.md"))).toBe(false);

    // The knowledge itself is still compiled and reachable — it moved channel, it
    // was not dropped. The warehouse the hook reads bodies from is the proof.
    const warehouse = readFileSync(
      join(home, "cache", ws.workspaceId, "warehouse.json"),
      "utf8",
    );
    expect(warehouse).toContain("Root convention");
    expect(warehouse).toContain("Src module rule");
  });

  it("is idempotent — a second run rewrites nothing", async () => {
    const home = freshDir("pathrule-cli-home-");
    const cwd = freshDir("pathrule-cli-ws-");
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;

    const ws = await initLocalWorkspace({ cwd, env, genWorkspaceId: () => "ws-idem" });
    const first = await syncLocalWorkspace(env, cwd, ws.workspaceId, {
      hookScriptSource: HOOK_SCRIPT_SOURCE,
    });
    expect(first.ok).toBe(true);
    expect(first.files.written).toBeGreaterThan(0);

    const second = await syncLocalWorkspace(env, cwd, ws.workspaceId, {
      hookScriptSource: HOOK_SCRIPT_SOURCE,
    });
    expect(second.ok).toBe(true);
    expect(second.files.written).toBe(0);
    expect(second.files.skipped).toBeGreaterThan(0);
  });

  it("reports a failed hook-script install without writing a dangling settings hook", async () => {
    const home = freshDir("pathrule-cli-home-");
    const cwd = freshDir("pathrule-cli-ws-");
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;

    const ws = await initLocalWorkspace({ cwd, env, genWorkspaceId: () => "ws-fail" });
    // Empty source = the embedded-define-missing failure mode.
    const result = await syncLocalWorkspace(env, cwd, ws.workspaceId, { hookScriptSource: "" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("hook_script_install_failed");
    expect(result.hook_script.ok).toBe(false);
    expect(existsSync(join(cwd, ".claude/settings.json"))).toBe(false);
    // The rest still ran — protocol file + hook-index don't depend on the script.
    expect(existsSync(join(cwd, ".claude/rules/pathrule-protocol.md"))).toBe(true);
    expect(result.hook_index.ok).toBe(true);
  });
});
