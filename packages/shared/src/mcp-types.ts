export type McpServerStatus =
  | "not-installed" // at least one AI client has a config but none holds a Pathrule entry
  | "installed" // at least one AI client has a valid Pathrule entry
  | "config-missing" // no AI client config exists on this machine yet
  | "error";

export interface McpServerEntry {
  /** stdio for spawn-based local servers; http for remote. Same shape across all four clients. */
  type: "stdio" | "http";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** A user-managed third-party MCP server shown in the Studio integrations
 *  panel. `stdio` carries command/args/env; `http` (remote/SSE) carries a url. */
export interface StudioMcpServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** HTTP auth/headers (e.g. { Authorization: "Bearer …" }) for remote servers. */
  headers?: Record<string, string>;
  /** True when parked in the disabled sidecar (not written to the live config). */
  disabled?: boolean;
  /** `user` = the user config (`~/.claude.json`, managed by this surface);
   *  `project` = the workspace's checked-in `.mcp.json` (read-only here);
   *  `plugin` = bundled by an installed Claude plugin (global, read-only). When
   *  unset, treat as `user`. */
  origin?: "user" | "project" | "plugin";
}

/** Secret-free server identity safe to expose across the Electron IPC boundary. */
export interface StudioMcpServerSummary {
  name: string;
  transport: "stdio" | "http";
  disabled?: boolean;
  origin?: "user" | "project" | "plugin";
}

/** A Claude subagent definition discovered on disk (`.claude/agents/*.md`,
 *  `~/.claude/agents`, or an installed plugin's `agents/`). Shown in the Studio
 *  integrations panel's Agents tab. Read-only (defined by files / plugins). */
export interface StudioAgent {
  /** Agent name (frontmatter `name`, else the file name). */
  name: string;
  /** Frontmatter `description` (when/why the agent is used), or "". */
  description: string;
  /** Frontmatter `tools` allowlist as written (e.g. "Read, Bash"), if present. */
  tools?: string;
  /** Frontmatter `model` (e.g. "sonnet", "haiku"), if present. */
  model?: string;
  /** `project` = workspace `.claude/agents`; `user` = `~/.claude/agents`;
   *  `plugin` = bundled by an installed plugin. user+plugin are "global". */
  origin: "project" | "user" | "plugin";
  /** Human label of the source (".claude/agents" or the plugin name). */
  source: string;
  /** Absolute path of the markdown file, so the panel can delete it. */
  filePath?: string;
}

/** Best-effort reachability of a third-party MCP server, computed by Studio
 *  (not Claude's live runtime): a launch test (stdio) or a probe (http). */
export type StudioMcpStatus = "connected" | "auth" | "error";

/**
 * Aggregated MCP status snapshot across all supported AI clients
 * (Claude Code, Cursor, Codex, Windsurf). Used by the TopBar chip and
 * any UI that needs a single yes/no answer to "is Pathrule wired in
 * anywhere on this machine?". Per-client detail lives in {@link ClientStatus}.
 */
export interface McpStatusSnapshot {
  status: McpServerStatus;
  configPath: string;
  serverCommand: string | null;
  serverArgs: string[] | null;
  error?: string;
}

export interface McpLogEntry {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  ts: string;
  extra?: Record<string, unknown>;
}

/** Result of installing/sweeping/uninstalling the Pathrule MCP entry
 *  in a single AI client's home config. */
export interface ClientInstallResult {
  client: string;
  ok: boolean;
  status: "installed" | "removed" | "skipped" | "error";
  configPath: string;
  wasNew?: boolean;
  wasPresent?: boolean;
  error?: string;
}

/** Per-client status snapshot used by Settings UI / tray menu. */
export interface ClientStatus {
  client: string;
  configPath: string;
  configExists: boolean;
  installed: boolean;
  serverCommand: string | null;
  serverArgs: string[] | null;
  error?: string;
}

/** Workspace-scoped status used by Settings → AI Tools.
 *  `active` reflects whether THIS workspace is currently wired to the
 *  client (selection or disk markers); machine-level fields are for UI
 *  tooltip context only. */
export interface WorkspaceClientStatus {
  client: string;
  active: boolean;
  selected: boolean;
  markers: string[];
  machineInstalled: boolean;
  machineConfigPath: string;
  machineConfigExists: boolean;
  managedOwner?: "desktop" | "cli" | "mcp";
  managedOwnerVersion?: string;
  managedOwnershipStatus?: "current" | "other_owner" | "newer_version" | "older_version";
}
