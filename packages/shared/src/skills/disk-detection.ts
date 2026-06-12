// Disk-marker detection for AI client presence in a workspace. Used by the
// skill materializer + multi-client renderer to decide which agent-target's
// folders to write into when no explicit user selection exists.
//
// Node-only. Import directly from "@pathrule/shared/skills/disk-detection.js" —
// do NOT re-export through the shared barrel (sandboxed preload + renderer).

import { access } from "node:fs/promises";
import { constants as FS_CONSTS } from "node:fs";
import { join } from "node:path";

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
}): AgentTargetId[] {
  const valid = new Set(Object.keys(AGENT_TARGETS) as AgentTargetId[]);
  const sel = (input.selected ?? []).filter(
    (s): s is AgentTargetId => typeof s === "string" && valid.has(s as AgentTargetId),
  );
  if (sel.length > 0) return sel;
  if (input.detected.length > 0) return [...input.detected];
  return [...input.fallback];
}
