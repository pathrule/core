// SPDX-License-Identifier: Apache-2.0
// End-to-end: `init --local` then `setup --local` in a temp home → the
// AI-client MCP config has a pathrule server with env.PATHRULE_LOCAL === "1"
// and args ending in ["mcp","run"], hooks installed, offline hook-index warmed.
// Real installers (real inject/merge); only the config-file location is
// redirected into the temp dir.

import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ configDir: { value: "" } }));

vi.mock("@pathrule/shared/mcp-installers/registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@pathrule/shared/mcp-installers/registry.js")>();
  return {
    ...actual,
    getInstallers: (id: never) =>
      actual.getInstallers(id).map((real, index) => ({
        ...real,
        homeConfigPath: () =>
          join(mocks.configDir.value, `${String(id)}${index > 0 ? `-${index}` : ""}.json`),
      })),
  };
});

import { initLocalWorkspace } from "./init-local.js";
import { parseLocalSetupArgs, runLocalSetup } from "./setup-local.js";

const HOOK_SCRIPT_SOURCE = "#!/usr/bin/env node\n// pathrule-hook test body\n";

describe("parseLocalSetupArgs", () => {
  it("accepts --target and --workspace-name", () => {
    expect(parseLocalSetupArgs(["--target", "claude", "--workspace-name", "My Site"])).toEqual({
      target: "claude",
      workspaceName: "My Site",
    });
    expect(parseLocalSetupArgs([])).toEqual({ target: null, workspaceName: null });
  });

  it("rejects cloud-only setup options loudly", () => {
    for (const cloudOnly of ["--org", "--workspace", "--create-workspace", "bootstrap"]) {
      expect(() => parseLocalSetupArgs([cloudOnly, "x"])).toThrowError(
        `unknown_setup_option:${cloudOnly}`,
      );
    }
    expect(() => parseLocalSetupArgs(["--target"])).toThrowError("missing_value:--target");
  });
});

describe("runLocalSetup (e2e)", () => {
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

  it("init --local then setup --local wires the PATHRULE_LOCAL MCP entry + hooks, no login", async () => {
    const home = freshDir("pathrule-setup-home-");
    const cwd = freshDir("pathrule-setup-ws-");
    mocks.configDir.value = freshDir("pathrule-setup-clients-");
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;

    const init = await initLocalWorkspace({ cwd, env, genWorkspaceId: () => "ws-setup-e2e" });
    expect(init.action).toBe("created");

    const result = await runLocalSetup({
      cwd,
      env,
      args: ["--target", "claude"],
      syncOptions: { hookScriptSource: HOOK_SCRIPT_SOURCE },
    });

    expect(result.ok).toBe(true);
    // Idempotent re-entry: setup reused the init'd store.
    expect(result.workspace.action).toBe("exists");
    expect(result.workspace.workspaceId).toBe("ws-setup-e2e");

    // The client MCP config: a pathrule server spawning `... mcp run` with
    // PATHRULE_LOCAL=1 and NO Supabase keys.
    const config = JSON.parse(
      readFileSync(join(mocks.configDir.value, "claude-code.json"), "utf8"),
    ) as {
      mcpServers?: Record<
        string,
        { command?: string; args?: string[]; env?: Record<string, string> }
      >;
    };
    const entry = config.mcpServers?.pathrule;
    expect(entry).toBeDefined();
    expect(entry?.command).toBe(process.execPath);
    expect(entry?.args?.slice(-2)).toEqual(["mcp", "run"]);
    expect(entry?.env?.PATHRULE_LOCAL).toBe("1");
    expect(entry?.env).not.toHaveProperty("SUPABASE_URL");
    expect(entry?.env).not.toHaveProperty("SUPABASE_ANON_KEY");

    // Hooks + offline index in place.
    expect(existsSync(join(home, "bin", "pathrule-hook.js"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/rules/pathrule-protocol.md"))).toBe(true);
    expect(existsSync(join(home, "cache", "ws-setup-e2e", "hook-index.json"))).toBe(true);
  });

  it("creates the workspace itself when init was skipped (one-command path)", async () => {
    const home = freshDir("pathrule-setup-home-");
    const cwd = freshDir("pathrule-setup-ws-");
    mocks.configDir.value = freshDir("pathrule-setup-clients-");
    const env = { PATHRULE_HOME: home } as NodeJS.ProcessEnv;

    const result = await runLocalSetup({
      cwd,
      env,
      args: ["--target", "claude", "--workspace-name", "Solo"],
      syncOptions: { hookScriptSource: HOOK_SCRIPT_SOURCE },
    });

    expect(result.ok).toBe(true);
    expect(result.workspace.action).toBe("created");
    expect(result.workspace.name).toBe("Solo");
    expect(existsSync(join(home, "cache", result.workspace.workspaceId, "hook-index.json"))).toBe(
      true,
    );
  });
});
