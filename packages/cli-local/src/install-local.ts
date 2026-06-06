// SPDX-License-Identifier: Apache-2.0
// The account-free half of the MCP installer. The local `setup --local`
// composition imports only what it needs from here and never pulls in any
// hosted-edition entry builder or credential config. install.ts imports the
// shared pieces from here and re-exports them, so other callers are unchanged.

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { getInstaller } from "@pathrule/shared/mcp-installers/registry.js";
import type { AgentTargetId } from "@pathrule/shared/skills/agent-targets.js";
import type { McpServerEntry } from "@pathrule/shared/mcp-types.js";
import { atomicWrite, readIfExists } from "@pathrule/shared/local-runtime/atomic-write.js";

import { cliPlatform } from "./platform.js";

// Re-exported so existing importers of these from install-local keep working;
// the canonical implementation lives in @pathrule/shared/local-runtime/atomic-write.
export { atomicWrite, readIfExists } from "@pathrule/shared/local-runtime/atomic-write.js";

export type CliInstallTarget = AgentTargetId | "all";

export interface CliInstallResult {
  client: AgentTargetId;
  ok: boolean;
  status: "installed" | "removed" | "not_present" | "error";
  config_path: string;
  was_new?: boolean;
  error?: string;
}

const TARGET_ALIASES: Record<string, CliInstallTarget> = {
  all: "all",
  claude: "claude-code",
  "claude-code": "claude-code",
  cursor: "cursor",
  codex: "codex",
  windsurf: "windsurf",
};

const ALL_TARGETS: AgentTargetId[] = ["claude-code", "cursor", "codex", "windsurf"];

export function parseInstallTargets(raw: string | undefined): AgentTargetId[] {
  const target = TARGET_ALIASES[(raw ?? "all").toLowerCase()];
  if (!target) {
    throw new Error("invalid_install_target");
  }
  return target === "all" ? ALL_TARGETS : [target];
}

/**
 * Install the local (no-login) MCP entry into AI-client configs. The entry
 * carries `PATHRULE_LOCAL=1` and no remote credentials, so the spawned
 * `pathrule mcp run` serves entirely off the local SQLite store. The
 * installers themselves are edition-agnostic.
 */
export async function installLocalCliTargets(
  rawTarget: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<CliInstallResult[]> {
  const targets = parseInstallTargets(rawTarget);
  return installEntryToCliTargets(targets, resolveLocalCliMcpEntry(env), env);
}

export async function installEntryToCliTargets(
  targets: AgentTargetId[],
  entry: McpServerEntry,
  env: NodeJS.ProcessEnv,
): Promise<CliInstallResult[]> {
  const platform = cliPlatform(env);
  return Promise.all(
    targets.map(async (target) => {
      const installer = getInstaller(target);
      const configPath = installer.homeConfigPath(homedir(), platform);
      try {
        const existing = await readIfExists(configPath);
        const result = installer.inject(existing, entry);
        await atomicWrite(configPath, result.body);
        return {
          client: target,
          ok: true,
          status: "installed" as const,
          config_path: configPath,
          was_new: result.wasNew,
        };
      } catch (err) {
        return {
          client: target,
          ok: false,
          status: "error" as const,
          config_path: configPath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/**
 * The local (no-login) variant of the MCP entry builder. Same deterministic
 * launch (`process.execPath` + bundled CLI + `mcp run`), but the entry's env
 * is just `PATHRULE_LOCAL=1`: the spawned MCP server serves the agent off
 * `~/.pathrule/<ws>/pathrule.db` with no account. No remote credentials are
 * written — local mode needs none.
 */
export function resolveLocalCliMcpEntry(env: NodeJS.ProcessEnv): McpServerEntry {
  const cliEntrypoint = resolveCliEntrypoint();
  const entry: McpServerEntry = {
    type: "stdio",
    command: process.execPath,
    args: [cliEntrypoint, "mcp", "run"],
    env: {
      PATHRULE_LOCAL: "1",
    },
  };
  applyPassthroughEnv(entry, env);
  return entry;
}

// Only forward env values that are actually present — empty strings can
// mask defaults inside the spawned process.
const MCP_ENTRY_ENV_PASSTHROUGH = [
  "PATHRULE_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
] as const;

export function applyPassthroughEnv(entry: McpServerEntry, env: NodeJS.ProcessEnv): void {
  for (const key of MCP_ENTRY_ENV_PASSTHROUGH) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") {
      entry.env![key] = value;
    }
  }
}

export function resolveCliEntrypoint(): string {
  // import.meta.url points at the bundled CLI dist file at runtime. Resolve
  // to an absolute filesystem path — Windows clients in particular cannot
  // launch via a `file://` URL or a relative path.
  return fileURLToPath(import.meta.url);
}
