// Pathrule agent protocol — the single source of truth for instructions that
// tell AI agents how to interact with the Pathrule MCP server. Consumed by:
//
//   1. MCP get_context response → `protocol` field (all clients)
//   2. .claude/rules/pathrule-protocol.md → auto-loaded by Claude Code
//   3. CLAUDE.md renderer → minimal "call get_context first" pointer
//
// Keep the three layers in sync by deriving everything from these constants.

import type { RoutingDecision } from "./routing-types.js";
import { stableHash } from "./versioning.js";
import {
  buildCodexHookEvents,
  buildCursorHookEvents,
  buildHookConfig,
} from "./hook-supervisor/client-config-writer.js";
import type { HookMatcher } from "./hook-supervisor/types.js";

export interface PathruleProtocol {
  before: string[];
  during: string[];
  after: string[];
}

/**
 * Structured protocol injected into every get_context response. LLMs see this
 * on every session start — no file reads required.
 *
 * Hook-aware flow: PreToolUse + UserPromptSubmit hooks inject the
 * workspace's memory/rule titles + session digest automatically. Most
 * prompts should proceed without any MCP call at all — the context is
 * already present. MCP tools are the *deep* layer: full bodies, discovery
 * queries, and writes.
 */
export const PATHRULE_PROTOCOL: PathruleProtocol = {
  // Minimal contract (V36). Framing the runtime already enforces (strict-rule obedience is blocked by
  // the PreToolUse deny gate; the route-block instruction is injected verbatim by the hook) and
  // feature procedures the hook delivers on demand (the full pattern-import steps, skill-hint wording)
  // were removed from the always-on protocol: they cost tokens every session for behavior that is either
  // deterministic or contextually delivered. What remains is only what the agent must be TOLD and cannot
  // learn from the runtime: the trust+no-re-explore lever (the discovery-saving behavior), the staleness
  // safety valve, when to reach for MCP, and the hard safety one-liners (skill/pattern gate, Signals).
  before: [
    "Pathrule is this workspace's knowledge layer: it compiles your path-scoped memory/rule/skill knowledge into your turn-zero files (CLAUDE.md / AGENTS.md / .claude/rules) and, injected by the Pathrule hook on a prompt, delivers the task-relevant full bodies, both AUTHORITATIVE. When the hook injects a memory/skill body, that body IS the content: use it directly, do not fetch it again. Act on Pathrule's knowledge directly; do NOT grep, search, or re-read files to re-verify what it already gave you. Open files only to read the current CODE you must edit or check.",
    "Compiled knowledge can go stale. If the current code contradicts it, the code wins for current behavior: STATE the contradiction (name the stale item and how the code differs), follow the code, and surface it so the team refreshes it. Never silently resolve a code-vs-knowledge conflict.",
    "Do NOT reflexively call pathrule_get_context before every small known-path task. DO call pathrule_get_context(cwd, user_intent, omit_protocol: true) before any grep/read/fallback when hook context is missing, ambiguous, or stale, or for discovery, inventory, architecture, or list/show/find/where/which questions (including Turkish: listele, göster, bul, nerede, hangi, neler). A semantic candidate is a lead, not an answer: call pathrule_read_memory(id) and read the body before citing one.",
    "`::skill-name` is a hard gate: run the exact injected skill. `::pathrule:package:<slug>` is a PATTERN import, not a skill: call pathrule_import_pattern(dry_run: true) first, judge fit against this workspace, then write. Follow the instruction the hook gives for each; do not improvise one.",
    "Pathrule Signals is opt-in and propose-first: never add Signals SDK calls to the user's code unless the user has enabled Signals AND approved the specific instrumentation.",
  ],
  during: [
    "Path-first writes: write_memory / write_rule / write_skill take a node_path string (e.g. '/apps/mobile'); target the most specific path (missing nodes auto-create).",
    "Fast edits: to UPDATE a memory/rule/skill you know by title, call pathrule_resolve(query) ONCE for its id + version_id (do NOT pull the tree or read bodies to hunt the id), then pathrule_update_* with a `content_edit` delta (append / str_replace / replace_section); reserve full `content` for a genuine rewrite.",
    "Never use local file-based memory (~/.claude/memory/, MEMORY.md). Pathrule is the single source of truth for persistent knowledge.",
  ],
  after: [
    "Log EVERY file-modifying response with pathrule_log_activity (fields: domain, action, scope, subjects ≤5, files_touched, task_summary).",
  ],
};

/**
 * 8-char SHA1 of the canonical JSON of `PATHRULE_PROTOCOL`. Bumped only when
 * developers edit this file. Clients that pass `known_protocol_version` matching
 * this value get a `protocol_unchanged: true` response with the body omitted.
 *
 * Memoized at module load — protocol is a constant, hash is computed once.
 */
export const PATHRULE_PROTOCOL_VERSION = stableHash(PATHRULE_PROTOCOL);

/**
 * Render the `.claude/rules/pathrule-protocol.md` file content. This file is
 * auto-loaded by Claude Code as a system-level rule — strongest guarantee
 * for CC users. Written alongside CLAUDE.md on every rerender.
 */
export function renderProtocolRulesFile(): string {
  const lines: string[] = [
    "# Pathrule Protocol",
    "",
    "This workspace uses Pathrule MCP. Follow this protocol on EVERY task.",
    "",
    "## BEFORE — mandatory first steps",
    "",
  ];

  let num = 1;
  for (const item of PATHRULE_PROTOCOL.before) {
    lines.push(`${num}. ${item}`);
    num++;
  }

  lines.push("", "## DURING — constraints while coding", "");
  for (const item of PATHRULE_PROTOCOL.during) {
    lines.push(`${num}. ${item}`);
    num++;
  }

  lines.push("", "## AFTER — mandatory after every file modification", "");
  for (const item of PATHRULE_PROTOCOL.after) {
    lines.push(`${num}. ${item}`);
    num++;
  }

  lines.push(""); // trailing newline
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// .claude/settings.json hook injection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Routing decision → human instruction
// ---------------------------------------------------------------------------

/**
 * Turn a router-issued RoutingDecision into a single, directive instruction
 * the calling LLM sees in the get_context response. Centralised here so the
 * wording is consistent across every MCP client.
 */
export function describeRoutingAction(decision: RoutingDecision): string {
  const files =
    decision.primary_files && decision.primary_files.length > 0
      ? ` Likely target(s): ${decision.primary_files.join(", ")}.`
      : "";
  switch (decision.next) {
    case "call_understand":
      // Legacy router output — the understand tool was replaced with a
      // depth-aware get_context. Treat it as "no_action" with a hint.
      return `Proceed with the task using the provided context.${files} ${decision.reason}`;
    case "read_memory":
      return decision.memory_id
        ? `Read memory ${decision.memory_id} — it likely contains the answer. ${decision.reason}`
        : `Read the matching memory from the workspace overview. ${decision.reason}`;
    case "execute_only":
      return `Run the requested command. No knowledge lookup needed. ${decision.reason}`;
    case "edit_known_path":
      return `Edit the file/path the user referenced.${files} No exploration needed. ${decision.reason}`;
    case "answer_directly":
      return `Answer from your own knowledge. ${decision.reason}`;
    case "no_action":
      return `Proceed directly with the task.${files} ${decision.reason}`;
  }
}

/**
 * Markers we match to identify Pathrule-owned hook entries. Substring match
 * recognises both the new script path AND the legacy `pathrule_log_activity`
 * reminder, so upgrading cleanly replaces the old hook regardless
 * of whether the existing entry is a tilde or absolute path.
 */
const HOOK_MARKERS = ["pathrule-hook.js", "pathrule_log_activity"] as const;

/**
 * Canonical set of hooks Pathrule installs. Three events wired:
 *   - PreToolUse: tool about to run → inject context, block rule violations
 *   - PostToolUse: tool finished → capture failures, pattern-log
 *   - UserPromptSubmit: user typed a prompt → inject session digest
 *
 * Resolved lazily via `buildHookConfig()` so each merger call picks up the
 * absolute hook command path configured by `setHookCommand()` at process
 * startup. Module-level caching would freeze in a tilde literal before the
 * setter ran.
 */
function pathruleHooks() {
  return buildHookConfig().hooks;
}

function pathruleCursorHooks() {
  return buildCursorHookEvents(buildHookConfig());
}

function pathruleCodexHooks() {
  return buildCodexHookEvents(buildHookConfig());
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[] | unknown>;
  [k: string]: unknown;
}

function commandMatchesMarker(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return HOOK_MARKERS.some((m) => cmd.includes(m));
}

/** Strip any existing Pathrule-owned entries from a hook list. */
function stripPathruleEntries(entries: HookMatcher[]): HookMatcher[] {
  const result: HookMatcher[] = [];
  for (const entry of entries) {
    const remaining = (entry.hooks ?? []).filter((h) => !commandMatchesMarker(h.command));
    if (remaining.length === 0) continue;
    result.push({ ...entry, hooks: remaining });
  }
  return result;
}

/**
 * Pure function: takes existing `.claude/settings.json` content (or null if
 * file doesn't exist) and returns the merged JSON string with Pathrule's
 * hook set installed. Idempotent:
 *   - first call: installs Pre/Post/UserPromptSubmit hooks
 *   - subsequent calls: no-op when already present (returns `changed: false`)
 *   - upgrade from legacy hook: strips the old reminder, installs new set
 *
 * Other hooks the user has configured are preserved untouched.
 */
export function ensureClaudeSettingsHook(
  existing: string | null,
  options?: { uninstall?: boolean },
): {
  body: string;
  changed: boolean;
} {
  let settings: ClaudeSettings = {};
  if (existing && existing.trim().length > 0) {
    try {
      settings = JSON.parse(existing) as ClaudeSettings;
    } catch {
      // Corrupt JSON — preserve raw content as a `_backup` key so nothing is lost.
      settings = { _backup: existing } as ClaudeSettings;
    }
  }

  if (!settings.hooks) settings.hooks = {};

  let changed = false;

  // Uninstall mirrors ensureCursorHooks: strip only OUR entries, keep every hook
  // the user wired themselves, and never delete this file. `.claude/settings.json`
  // holds permissions, plugins, and editor preferences, so it belongs to the user
  // even when Pathrule is the reason it exists.
  if (options?.uninstall === true) {
    const hooks = settings.hooks as Record<string, unknown>;
    for (const event of Object.keys(hooks)) {
      const existingRaw = hooks[event];
      if (!Array.isArray(existingRaw)) continue;
      const nonPathrule = stripPathruleEntries(existingRaw as HookMatcher[]);
      if (nonPathrule.length === (existingRaw as HookMatcher[]).length) continue;
      if (nonPathrule.length === 0) delete hooks[event];
      else (hooks as Record<string, HookMatcher[]>)[event] = nonPathrule;
      changed = true;
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
    return { body: JSON.stringify(settings, null, 2) + "\n", changed };
  }

  for (const [event, desired] of Object.entries(pathruleHooks())) {
    const existingRaw = settings.hooks[event];
    const existingEntries = Array.isArray(existingRaw) ? (existingRaw as HookMatcher[]) : [];

    // Fast path: if exactly our entries are present, skip.
    const pathruleEntries = existingEntries.filter((entry) =>
      (entry.hooks ?? []).some((h) => commandMatchesMarker(h.command)),
    );
    const nonPathrule = stripPathruleEntries(existingEntries);

    const alreadyInstalled =
      pathruleEntries.length === desired.length &&
      pathruleEntries.every((entry, i) => {
        const want = desired[i];
        if (!want) return false;
        const gotHooks = entry.hooks;
        const wantHooks = want.hooks;
        return (
          (entry.matcher ?? "") === (want.matcher ?? "") &&
          gotHooks.length === wantHooks.length &&
          gotHooks.every((h, j) => h.command === wantHooks[j]?.command)
        );
      });

    if (alreadyInstalled) continue;

    // Replace Pathrule's entries; keep everything else the user set up.
    settings.hooks[event] = [...nonPathrule, ...desired];
    changed = true;
  }

  return { body: JSON.stringify(settings, null, 2) + "\n", changed };
}

// ---------------------------------------------------------------------------
// .cursor/hooks.json merge — same shape strategy as ensureClaudeSettingsHook,
// but Cursor's lowercase event names + top-level `version: 1` field. Preserves
// every hook the user already wired (e.g., their own preToolUse safety guard)
// and only swaps Pathrule's entries in/out using the shared command marker.
// ---------------------------------------------------------------------------

interface CursorHooksFile {
  version?: number;
  hooks?: Record<string, HookMatcher[] | unknown>;
  [k: string]: unknown;
}

export function ensureCursorHooks(
  existing: string | null,
  options?: { uninstall?: boolean },
): {
  body: string;
  changed: boolean;
} {
  let file: CursorHooksFile = { version: 1 };
  if (existing && existing.trim().length > 0) {
    try {
      file = JSON.parse(existing) as CursorHooksFile;
    } catch {
      file = { version: 1, _backup: existing } as CursorHooksFile;
    }
  }
  if (typeof file.version !== "number") file.version = 1;
  if (!file.hooks || typeof file.hooks !== "object") file.hooks = {};

  const uninstall = options?.uninstall === true;
  let changed = false;

  if (uninstall) {
    // Strip every Pathrule-marked entry. Leave user-defined hooks intact.
    for (const event of Object.keys(file.hooks as Record<string, unknown>)) {
      const existingRaw = (file.hooks as Record<string, unknown>)[event];
      if (!Array.isArray(existingRaw)) continue;
      const nonPathrule = stripPathruleEntries(existingRaw as HookMatcher[]);
      if (nonPathrule.length === (existingRaw as HookMatcher[]).length) continue;
      if (nonPathrule.length === 0) {
        delete (file.hooks as Record<string, unknown>)[event];
      } else {
        (file.hooks as Record<string, HookMatcher[]>)[event] = nonPathrule;
      }
      changed = true;
    }
    // If nothing remains beyond version + empty hooks, signal the caller to
    // unlink the file entirely (returning "" lets atomicWriteOrUnlink delete).
    const remainingKeys = Object.keys(file).filter((k) => k !== "version" && k !== "hooks");
    const remainingHookKeys = Object.keys(file.hooks as Record<string, unknown>);
    if (remainingKeys.length === 0 && remainingHookKeys.length === 0) {
      return { body: "", changed: true };
    }
    return { body: JSON.stringify(file, null, 2) + "\n", changed };
  }

  for (const [event, desired] of Object.entries(pathruleCursorHooks())) {
    const existingRaw = (file.hooks as Record<string, unknown>)[event];
    const existingEntries = Array.isArray(existingRaw) ? (existingRaw as HookMatcher[]) : [];

    const pathruleEntries = existingEntries.filter((entry) =>
      (entry.hooks ?? []).some((h) => commandMatchesMarker(h.command)),
    );
    const nonPathrule = stripPathruleEntries(existingEntries);

    const alreadyInstalled =
      pathruleEntries.length === desired.length &&
      pathruleEntries.every((entry, i) => {
        const want = desired[i];
        if (!want) return false;
        return (
          (entry.matcher ?? "") === (want.matcher ?? "") &&
          entry.hooks.length === want.hooks.length &&
          entry.hooks.every((h, j) => h.command === want.hooks[j]?.command)
        );
      });

    if (
      alreadyInstalled &&
      nonPathrule.length === existingEntries.length - pathruleEntries.length
    ) {
      continue;
    }
    (file.hooks as Record<string, HookMatcher[]>)[event] = [...nonPathrule, ...desired];
    changed = true;
  }

  return { body: JSON.stringify(file, null, 2) + "\n", changed };
}

// ---------------------------------------------------------------------------
// .codex/hooks.json merge — Codex follows Claude's hook-config shape almost
// verbatim (PascalCase event names, hooks object). We reuse the same Pathrule
// command marker so cross-client tooling stays consistent.
// ---------------------------------------------------------------------------

export function ensureCodexHooks(
  existing: string | null,
  options?: { uninstall?: boolean },
): {
  body: string;
  changed: boolean;
} {
  let file: { hooks?: Record<string, HookMatcher[] | unknown>; [k: string]: unknown } = {};
  if (existing && existing.trim().length > 0) {
    try {
      file = JSON.parse(existing);
    } catch {
      file = { _backup: existing };
    }
  }
  if (!file.hooks || typeof file.hooks !== "object") file.hooks = {};

  const uninstall = options?.uninstall === true;
  let changed = false;

  if (uninstall) {
    for (const event of Object.keys(file.hooks as Record<string, unknown>)) {
      const existingRaw = (file.hooks as Record<string, unknown>)[event];
      if (!Array.isArray(existingRaw)) continue;
      const nonPathrule = stripPathruleEntries(existingRaw as HookMatcher[]);
      if (nonPathrule.length === (existingRaw as HookMatcher[]).length) continue;
      if (nonPathrule.length === 0) {
        delete (file.hooks as Record<string, unknown>)[event];
      } else {
        (file.hooks as Record<string, HookMatcher[]>)[event] = nonPathrule;
      }
      changed = true;
    }
    const remainingKeys = Object.keys(file).filter((k) => k !== "hooks");
    const remainingHookKeys = Object.keys(file.hooks as Record<string, unknown>);
    if (remainingKeys.length === 0 && remainingHookKeys.length === 0) {
      return { body: "", changed: true };
    }
    return { body: JSON.stringify(file, null, 2) + "\n", changed };
  }

  for (const [event, desired] of Object.entries(pathruleCodexHooks())) {
    const existingRaw = (file.hooks as Record<string, unknown>)[event];
    const existingEntries = Array.isArray(existingRaw) ? (existingRaw as HookMatcher[]) : [];

    const pathruleEntries = existingEntries.filter((entry) =>
      (entry.hooks ?? []).some((h) => commandMatchesMarker(h.command)),
    );
    const nonPathrule = stripPathruleEntries(existingEntries);

    const alreadyInstalled =
      pathruleEntries.length === desired.length &&
      pathruleEntries.every((entry, i) => {
        const want = desired[i];
        if (!want) return false;
        return (
          (entry.matcher ?? "") === (want.matcher ?? "") &&
          entry.hooks.length === want.hooks.length &&
          entry.hooks.every((h, j) => h.command === want.hooks[j]?.command)
        );
      });

    if (
      alreadyInstalled &&
      nonPathrule.length === existingEntries.length - pathruleEntries.length
    ) {
      continue;
    }
    (file.hooks as Record<string, HookMatcher[]>)[event] = [...nonPathrule, ...desired];
    changed = true;
  }

  return { body: JSON.stringify(file, null, 2) + "\n", changed };
}

// ---------------------------------------------------------------------------
// .codex/config.toml merge — Codex requires `[features] hooks = true` to load
// hooks. (The older `codex_hooks` key is deprecated; Codex emits a deprecation
// warning when it sees it.) We add this as a marker-bound block at the end of
// whatever TOML the user already has, leaving every other key alone. The
// marker-bound merger replaces an older block on the next render, so existing
// `codex_hooks` configs migrate automatically. Idempotent.
// ---------------------------------------------------------------------------

const CODEX_TOML_START = "# >>> Pathrule managed (codex hook activation) >>>";
const CODEX_TOML_END = "# <<< Pathrule managed <<<";
const CODEX_TOML_BLOCK = [
  CODEX_TOML_START,
  "[features]",
  "hooks = true",
  CODEX_TOML_END,
  "",
].join("\n");

export function ensureCodexConfigToml(
  existing: string | null,
  options?: { uninstall?: boolean },
): {
  body: string;
  changed: boolean;
} {
  const normalized = (existing ?? "").replace(/\r\n/g, "\n");
  const startIdx = normalized.indexOf(CODEX_TOML_START);
  const endIdx = normalized.indexOf(CODEX_TOML_END);

  let stripped = normalized;
  if (startIdx >= 0 && endIdx > startIdx) {
    const after = normalized.slice(endIdx + CODEX_TOML_END.length).replace(/^\n+/, "");
    stripped = (normalized.slice(0, startIdx).trimEnd() + (after ? `\n\n${after}` : "")).trimEnd();
  } else {
    stripped = normalized.trimEnd();
  }

  if (options?.uninstall === true) {
    const result = stripped.length > 0 ? `${stripped}\n` : "";
    return { body: result, changed: result !== normalized };
  }

  const next = stripped.length > 0 ? `${stripped}\n\n${CODEX_TOML_BLOCK}` : CODEX_TOML_BLOCK;
  if (normalized === next) return { body: normalized, changed: false };
  return { body: next, changed: true };
}
