// SPDX-License-Identifier: Apache-2.0
// After syncLocalWorkspace runs in a temp PATHRULE_HOME + cwd, the hook script,
// the .claude/settings.json hook block, the static protocol rules file, and
// cache/<wsId>/hook-index.json all exist.

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    // 3. Static protocol rules file (no backend, no CLAUDE.md render).
    const protocol = readFileSync(join(cwd, ".claude/rules/pathrule-protocol.md"), "utf8");
    expect(protocol).toContain("Pathrule");

    // 4. Offline hook-index warmed from the local store.
    expect(result.hook_index.ok).toBe(true);
    const index = JSON.parse(
      readFileSync(join(home, "cache", "ws-sync-local", "hook-index.json"), "utf8"),
    ) as { workspace_id?: string; workspace_root?: string };
    expect(index.workspace_id).toBe("ws-sync-local");
    expect(index.workspace_root).toBe(cwd);

    // Managed-file ownership recorded for repair/uninstall.
    expect(existsSync(join(cwd, ".pathrule/managed-files.json"))).toBe(true);
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
