import {
  CLAUDE_TO_CODEX_EVENT_MAP,
  CLAUDE_TO_CODEX_TOOL_MAP,
  CLAUDE_TO_CURSOR_EVENT_MAP,
  CLAUDE_TO_CURSOR_TOOL_MAP,
} from "./event-mapping.js";
import { getHookCommand } from "./hook-command.js";
import type { HookConfig, HookEventName, HookMatcher } from "./types.js";

// Tools Cursor's hook surface actually exposes (https://cursor.com/docs/agent/hooks).
// Claude tools without a Cursor analogue (Glob, WebFetch, WebSearch) are
// dropped from the Cursor matcher rather than carried through dead.
const CURSOR_TOOL_SET = new Set(["Read", "Write", "Grep", "Delete", "Task", "Shell"]);

// Events whose Cursor-native output schema can carry Pathrule's payload.
// UserPromptSubmit -> beforeSubmitPrompt is intentionally absent: Cursor's
// beforeSubmitPrompt accepts only { continue, user_message } — no
// additional_context — so wiring the matcher would burn one process per
// prompt for zero injection. SessionStart + PostToolUse cover the same
// ground for Cursor users (one-shot bootstrap + reactive path-scoped).
const CURSOR_SUPPORTED_EVENTS = new Set<HookEventName>([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "SessionEnd",
]);

function cloneMatchers(matchers: readonly HookMatcher[]): HookMatcher[] {
  return matchers.map((matcher) => ({
    matcher: matcher.matcher,
    hooks: matcher.hooks.map((hook) => ({ ...hook })),
  }));
}

function mapMatcherToCursor(matcher: HookMatcher): HookMatcher | null {
  if (!matcher.matcher) return matcher;
  const seen = new Set<string>();
  const mapped: string[] = [];
  for (const name of matcher.matcher.split("|")) {
    const cursorName = CLAUDE_TO_CURSOR_TOOL_MAP[name] ?? name;
    if (!CURSOR_TOOL_SET.has(cursorName)) continue;
    if (seen.has(cursorName)) continue;
    seen.add(cursorName);
    mapped.push(cursorName);
  }
  if (mapped.length === 0) return null;
  return { ...matcher, matcher: mapped.join("|") };
}

export function buildHookConfig(scriptPath?: string): HookConfig {
  const cmd = scriptPath ?? getHookCommand();
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: cmd }] }],
      PreToolUse: [
        {
          matcher: "Read|Edit|Write|Grep|Glob|Bash",
          hooks: [{ type: "command", command: cmd }],
        },
      ],
      PostToolUse: [
        {
          matcher: "Read|Edit|Write|Bash",
          hooks: [{ type: "command", command: cmd }],
        },
      ],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd }] }],
      Stop: [{ hooks: [{ type: "command", command: cmd }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: cmd }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: cmd }] }],
    },
  };
}

export function renderClaudeSettings(config: HookConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Per-event Cursor matcher map — shared by `renderCursorHooks` (fresh emit)
 *  and `ensureCursorHooks` (merger that preserves user's other entries). */
export function buildCursorHookEvents(config: HookConfig): Record<string, HookMatcher[]> {
  const hooks: Record<string, HookMatcher[]> = {};
  for (const [rawEvent, rawMatchers] of Object.entries(config.hooks)) {
    const event = rawEvent as HookEventName;
    if (!CURSOR_SUPPORTED_EVENTS.has(event)) continue;
    const cursorEvent = CLAUDE_TO_CURSOR_EVENT_MAP[event];
    if (!cursorEvent || !rawMatchers || rawMatchers.length === 0) continue;
    const mapped = cloneMatchers(rawMatchers)
      .map(mapMatcherToCursor)
      .filter((m): m is HookMatcher => m !== null);
    if (mapped.length === 0) continue;
    hooks[cursorEvent] = mapped;
  }
  return hooks;
}

export function renderCursorHooks(config: HookConfig): string {
  return `${JSON.stringify({ version: 1, hooks: buildCursorHookEvents(config) }, null, 2)}\n`;
}

// ─── Codex (https://developers.openai.com/codex/hooks) ─────────────────────
// Codex's hook contract is a near-clone of Claude's: PascalCase event names,
// hookSpecificOutput.additionalContext for context injection, decision/
// permissionDecision for blocks. The only divergences are tool names
// (apply_patch instead of Edit/Write, no Read hook) and the activation
// requirement (config.toml [features] codex_hooks = true).
const CODEX_TOOL_SET = new Set(["Bash", "apply_patch"]);

const CODEX_SUPPORTED_EVENTS = new Set<HookEventName>([
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
]);

function mapMatcherToCodex(matcher: HookMatcher): HookMatcher | null {
  if (!matcher.matcher) return matcher;
  const seen = new Set<string>();
  const mapped: string[] = [];
  for (const name of matcher.matcher.split("|")) {
    const codexName = CLAUDE_TO_CODEX_TOOL_MAP[name] ?? name;
    if (!CODEX_TOOL_SET.has(codexName)) continue;
    if (seen.has(codexName)) continue;
    seen.add(codexName);
    mapped.push(codexName);
  }
  if (mapped.length === 0) return null;
  return { ...matcher, matcher: mapped.join("|") };
}

export function buildCodexHookEvents(config: HookConfig): Record<string, HookMatcher[]> {
  const hooks: Record<string, HookMatcher[]> = {};
  for (const [rawEvent, rawMatchers] of Object.entries(config.hooks)) {
    const event = rawEvent as HookEventName;
    if (!CODEX_SUPPORTED_EVENTS.has(event)) continue;
    const codexEvent = CLAUDE_TO_CODEX_EVENT_MAP[event];
    if (!codexEvent || !rawMatchers || rawMatchers.length === 0) continue;
    const mapped = cloneMatchers(rawMatchers)
      .map(mapMatcherToCodex)
      .filter((m): m is HookMatcher => m !== null);
    // Keep matcher-less entries (UserPromptSubmit, SessionStart, Stop) as-is.
    if (mapped.length === 0 && rawMatchers.some((m) => !m.matcher)) {
      hooks[codexEvent] = cloneMatchers(rawMatchers).filter((m) => !m.matcher);
      continue;
    }
    if (mapped.length === 0) continue;
    hooks[codexEvent] = mapped;
  }
  return hooks;
}

export function renderCodexHooks(config: HookConfig): string {
  return `${JSON.stringify({ hooks: buildCodexHookEvents(config) }, null, 2)}\n`;
}
