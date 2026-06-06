// Agent target registry — which external coding agents Pathrule knows how to
// materialize skills for. V1 ships the Claude Code adapter only; new entries
// plug in by appending to AGENT_TARGETS.
//
// Browser-safe: no fs/path imports. The materializer (Node-only) consumes
// these records and does the disk writes.

export type AgentTargetId = "claude-code" | "cursor" | "windsurf" | "codex";

export interface AgentTargetSpec {
  /** Stable id stored in workspaces.active_agent_targets. */
  id: AgentTargetId;
  /** Human-facing label for Settings UI + toasts. */
  label: string;
  /** Workspace-relative directory that holds per-skill subfolders. */
  skillsDir: string;
  /** Workspace-relative marker file whose presence auto-detects the agent. */
  detectFile: string;
  /** Whether the materializer is implemented for this target. */
  supported: boolean;
}

export const AGENT_TARGETS: Record<AgentTargetId, AgentTargetSpec> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    skillsDir: ".claude/skills",
    detectFile: ".claude",
    supported: true,
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    skillsDir: ".cursor/skills",
    detectFile: ".cursor",
    supported: true,
  },
  windsurf: {
    id: "windsurf",
    label: "Windsurf",
    skillsDir: ".windsurf/skills",
    detectFile: ".windsurf",
    supported: true,
  },
  codex: {
    id: "codex",
    label: "Codex",
    skillsDir: ".codex/skills",
    detectFile: ".codex",
    supported: true,
  },
};

export const DEFAULT_ACTIVE_AGENT_TARGETS: AgentTargetId[] = ["claude-code"];

export function getAgentTargetSpec(id: string): AgentTargetSpec | null {
  return (AGENT_TARGETS as Record<string, AgentTargetSpec>)[id] ?? null;
}

export function filterSupportedTargets(ids: string[]): AgentTargetSpec[] {
  const out: AgentTargetSpec[] = [];
  for (const id of ids) {
    const spec = getAgentTargetSpec(id);
    if (spec && spec.supported) out.push(spec);
  }
  return out;
}
