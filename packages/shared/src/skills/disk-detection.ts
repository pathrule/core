// Disk-marker detection for AI client presence in a workspace. Used by the
// skill materializer + multi-client renderer to decide which agent-target's
// folders to write into when no explicit user selection exists.
//
// Node-only. Import directly from "@pathrule/shared/skills/disk-detection.js" —
// do NOT re-export through the shared barrel (sandboxed preload + renderer).

import { access, readFile } from "node:fs/promises";
import { constants as FS_CONSTS } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  HOOK_CONFIG_LOCATIONS,
  configInstallsPathruleHook,
} from "../client-renderers/hook-installed.js";
import { AGENT_TARGETS, type AgentTargetId } from "./agent-targets.js";

/**
 * Marker files whose presence implies the client is wired into this
 * workspace. Pathrule-owned filenames only — bare directories (`.claude`,
 * `.cursor`, `.codex`, `.windsurf`) are excluded so a leftover folder from
 * the AI tool's own state (e.g. `.claude/scheduled_tasks.lock`,
 * `.cursor/mcp.json` written by the user) doesn't keep the renderer
 * re-enabling a client the user has explicitly disabled.
 */
const MARKERS: Record<AgentTargetId, readonly string[]> = {
  "claude-code": ["CLAUDE.md", ".claude/rules/pathrule-protocol.md", ".claude/settings.json"],
  cursor: [".cursorrules", ".cursor/rules/pathrule-protocol.mdc", ".cursor/hooks.json"],
  codex: ["codex.md", "AGENTS.md", ".codex/hooks.json", ".codex/config.toml"],
  windsurf: [".windsurfrules", ".windsurf/rules/pathrule-protocol.md"],
  // Bare `.github/` is deliberately NOT a marker (every repo has one), and
  // AGENTS.md stays claimed by codex above so a shared-standard file doesn't
  // double-enable both clients.
  copilot: [".github/copilot-instructions.md", ".github/hooks/pathrule.json"],
};

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, FS_CONSTS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan workspaceRoot for any known client marker. Returns the deduplicated
 * list of detected clients. Order: stable by AGENT_TARGETS key order so
 * downstream callers can rely on it for UI sorting.
 */
export async function detectClientsOnDisk(workspaceRoot: string): Promise<AgentTargetId[]> {
  const ids = Object.keys(AGENT_TARGETS) as AgentTargetId[];
  const checks = await Promise.all(
    ids.map(async (id) => {
      for (const marker of MARKERS[id]) {
        if (await exists(join(workspaceRoot, marker))) return id;
      }
      return null;
    }),
  );
  return checks.filter((x): x is AgentTargetId => x !== null);
}

/**
 * Resolve which clients should receive disk writes (skills, companion files)
 * for this workspace + user.
 *
 * Precedence:
 *   1. Explicit selection in `user_workspace_paths.selected_ai_clients` —
 *      treated as the canonical enabled set when non-empty (the user has
 *      toggled at least one tool through onboarding/tray/settings).
 *   2. Disk markers — when no explicit selection exists, every client whose
 *      footprint is visible in the workspace is enabled. This is the
 *      signal-driven default that lets a teammate's `.cursorrules` commit
 *      auto-enable Cursor for everyone who clones the repo.
 *   3. `DEFAULT_ACTIVE_AGENT_TARGETS` — final safety net (claude-code only)
 *      so legacy workspaces with no signal at all keep their existing
 *      behaviour.
 *
 * Anything that came back from selection but isn't a known AgentTargetId is
 * dropped — guards against schema drift if a future client id is removed.
 */
export function resolveEnabledClients(input: {
  selected: readonly string[] | null | undefined;
  detected: readonly AgentTargetId[];
  fallback: readonly AgentTargetId[];
  /**
   * Engines Studio can actually run for this workspace (agent-gateway ids:
   * antigravity, grok, kimi, opencode, ...). See `requiredTargetsForEngines`.
   */
  activeEngines?: readonly string[];
}): AgentTargetId[] {
  const valid = new Set(Object.keys(AGENT_TARGETS) as AgentTargetId[]);
  const sel = (input.selected ?? []).filter(
    (s): s is AgentTargetId => typeof s === "string" && valid.has(s as AgentTargetId),
  );

  const base = sel.length > 0 ? sel : input.detected.length > 0 ? [...input.detected] : [...input.fallback];
  return withEngineTargets(base, input.activeEngines ?? []);
}

/**
 * Targets that must be enabled for a set of Studio engines to receive anything.
 *
 * Studio can run engines that are not companion targets in their own right
 * (antigravity, grok, kimi, opencode). They all read AGENTS.md, which Pathrule
 * writes as part of the `codex` target — so with only `claude-code` ticked, an
 * agent running inside Studio got no Pathrule knowledge at all. Delivery must
 * follow the engines actually in use, not an unrelated checkbox.
 */
export function requiredTargetsForEngines(engines: readonly string[]): AgentTargetId[] {
  const out = new Set<AgentTargetId>();
  for (const engine of engines) {
    switch (engine) {
      case "claude-code":
        out.add("claude-code");
        break;
      // Every other Studio engine reads AGENTS.md, which the codex target owns.
      case "codex":
      case "antigravity":
      case "grok":
      case "kimi":
      case "opencode":
        out.add("codex");
        break;
      default:
        // `orchestrator` and any future id: no channel of its own. Adding an
        // engine to studio/agent-gateway.ts AgentId without a case here fails
        // the engine-coverage contract test, which is the point.
        break;
    }
  }
  return [...out];
}

/**
 * Every engine Studio can launch as a chat. Kept in sync with `AgentId` in
 * studio/agent-gateway.ts; `orchestrator` is excluded because it dispatches to
 * the others rather than reading instruction files itself.
 *
 * Sync writes use this so a running engine is never starved of knowledge just
 * because the user ticked a different tool in settings.
 */
export const STUDIO_ENGINE_IDS = [
  "claude-code",
  "codex",
  "opencode",
  "grok",
  "kimi",
  "antigravity",
] as const;

/** Union of an enabled set with whatever the active engines require. */
export function withEngineTargets(
  enabled: readonly AgentTargetId[],
  engines: readonly string[],
): AgentTargetId[] {
  const out = new Set<AgentTargetId>(enabled);
  for (const target of requiredTargetsForEngines(engines)) out.add(target);
  return [...out];
}

/**
 * Which clients have Pathrule's HOOK installed for this workspace.
 *
 * Distinct from `detectClientsOnDisk`, and the difference is the whole point:
 * that function answers "is this client wired into the workspace at all" from
 * marker files, several of which Pathrule itself writes. This one answers "will
 * something actually deliver the protocol at runtime", which only a real hook
 * entry in the client's own config can prove.
 *
 * Read-only. Any failure resolves to NOT installed, because a wrong "installed"
 * takes the protocol off disk with nothing replacing it, while a wrong "not
 * installed" only leaves a file bigger than it needed to be.
 */
export async function detectInstalledHooks(
  workspaceRoot: string,
  opts: { home?: string } = {},
): Promise<AgentTargetId[]> {
  const home = opts.home ?? homedir();
  const out: AgentTargetId[] = [];
  for (const id of Object.keys(HOOK_CONFIG_LOCATIONS) as AgentTargetId[]) {
    const locations = HOOK_CONFIG_LOCATIONS[id];
    let installed = false;
    for (const loc of locations) {
      const base = loc.scope === "user" ? home : workspaceRoot;
      let body: string;
      try {
        body = await readFile(join(base, loc.path), "utf8");
      } catch {
        continue;
      }
      if (configInstallsPathruleHook(body)) {
        installed = true;
        break;
      }
    }
    if (installed) out.push(id);
  }
  return out;
}
