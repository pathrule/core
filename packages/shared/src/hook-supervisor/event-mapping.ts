import type { HookEventName } from "./types.js";

export type CursorHookEventName =
  | "preToolUse"
  | "postToolUse"
  | "beforeSubmitPrompt"
  | "sessionStart"
  | "stop"
  | "subagentStop"
  | "sessionEnd";

export const CLAUDE_TO_CURSOR_EVENT_MAP: Record<HookEventName, CursorHookEventName | null> = {
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  UserPromptSubmit: "beforeSubmitPrompt",
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  Stop: "stop",
  SubagentStop: "subagentStop",
  Notification: null,
  PreCompact: null,
  PostCompact: null,
};

export const CURSOR_TO_CLAUDE_EVENT_MAP: Record<CursorHookEventName, HookEventName> = {
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  beforeSubmitPrompt: "UserPromptSubmit",
  sessionStart: "SessionStart",
  stop: "Stop",
  subagentStop: "SubagentStop",
  sessionEnd: "SessionEnd",
};

export const CURSOR_TO_CLAUDE_TOOL_MAP: Record<string, string> = {
  Write: "Edit",
  Shell: "Bash",
};

export const CLAUDE_TO_CURSOR_TOOL_MAP: Record<string, string> = {
  Edit: "Write",
  Bash: "Shell",
};

// ─── Codex (https://developers.openai.com/codex/hooks) ─────────────────────
// Codex uses the same PascalCase event names as Claude (PreToolUse, PostToolUse,
// SessionStart, UserPromptSubmit, Stop). It does NOT have SubagentStop or
// SessionEnd. Codex adds PermissionRequest which we do not consume yet.
export type CodexHookEventName =
  | "SessionStart"
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "Stop"
  | "PermissionRequest";

export const CLAUDE_TO_CODEX_EVENT_MAP: Record<HookEventName, CodexHookEventName | null> = {
  PreToolUse: "PreToolUse",
  PostToolUse: "PostToolUse",
  UserPromptSubmit: "UserPromptSubmit",
  SessionStart: "SessionStart",
  SessionEnd: null,
  Stop: "Stop",
  SubagentStop: null,
  Notification: null,
  PreCompact: null,
  PostCompact: null,
};

// Codex's edit/write tool is `apply_patch` (single tool that handles
// add/update/delete via `*** File:` patch headers). Bash is unchanged. Read is
// not a hookable Codex tool today (file reads happen via shell / unified_exec).
export const CLAUDE_TO_CODEX_TOOL_MAP: Record<string, string> = {
  Edit: "apply_patch",
  Write: "apply_patch",
};

export const CODEX_TO_CLAUDE_TOOL_MAP: Record<string, string> = {
  apply_patch: "Edit",
};
