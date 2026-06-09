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
  before: [
    "Pathrule is the first knowledge layer for this workspace. Hooks auto-inject path-scoped memory/rule titles + session digest on every tool call and user prompt. Trust that context before falling back to files, git, or general knowledge.",
    "`::skill-name` is a hard gate: use the exact injected skill; if missing, stop and resolve it through Pathrule/MCP before file edits.",
    "`::pathrule:package:<slug>` is a PATTERN import, NOT a skill — never run find-skills for it. To import: (1) call pathrule_import_pattern(workspace_id, slug, dry_run:true) to see the pattern's appliesTo (stacks/packages/paths) + pieces WITHOUT writing; (2) judge fit against THIS workspace and choose the node_path base that matches the user's actual tree (e.g. /apps/mobile) — if the pattern does not fit (its stack/packages aren't in the project), STOP and ask the user whether and where to add it; (3) call again with that node_path to write, then relay the returned human_message. Undo a whole bundle with pathrule_remove_pattern(workspace_id, slug, node_path) using the same base. Same behaviour in the cloud and local editions.",
    "Do NOT reflexively call pathrule_get_context before every small known-path code task. DO call pathrule_get_context(cwd, user_intent, omit_protocol: true) before any grep/read/fallback when hook context is missing, ambiguous, stale, or the user asks for discovery, inventory, architecture, recent activity, or list/show/find/where/which style questions (including Turkish: listele, göster, bul, nerede, hangi, neler).",
    "Hook silence on a topic does not mean Pathrule has no relevant memory/rule. For discovery/inventory/architecture questions, call pathrule_get_context first; fall back to files, git, or general knowledge only after Pathrule returns nothing relevant. It's a single unified tool: the router classifies intent and returns a depth-appropriate response - minimal for ui_tweak/new_feature on a known path, focused for bug_fix/refactor, deep for debug/discovery.",
    "For discovery/inventory questions, treat `subtree_memory_index`, `discovery_signal`, and `semantic_candidates` as Pathrule evidence before filesystem fallback. Semantic candidates are not answers or rules: call pathrule_read_memory(id) and inspect the body before citing or following one.",
    "The response tells you `next_required_action.primary_files` when the router is confident — edit those directly. For full memory/rule bodies: pathrule_read_memory(id) / pathrule_read_rule(id).",
    "Obey every rule the hooks surface (advisory + strict). Apply every memory whose title looks relevant — fetch the body only when you want to cite or follow it.",
    "Treat existing local edits as protected user/team work: inspect before touching overlapping files, never revert unrelated changes, and keep edits scoped to the user's request.",
  ],
  during: [
    "Path-first writes: write_memory / write_rule / write_skill take a node_path string (e.g. '/apps/mobile'). Target the most specific path; missing nodes auto-create.",
    "Never use local file-based memory (~/.claude/memory/, MEMORY.md). Pathrule is the single source of truth for all persistent knowledge.",
    "After every write, summarise what you did in natural language — don't paste raw tool JSON.",
  ],
  after: [
    "Log EVERY file-modifying response with pathrule_log_activity. Trigger: did you modify files? → log it. Required fields: domain, action, scope, subjects (≤5 keywords), files_touched, task_summary.",
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
export function ensureClaudeSettingsHook(existing: string | null): {
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
// .codex/config.toml merge — Codex requires `[features] codex_hooks = true`
// to load hooks. We add this as a marker-bound block at the end of whatever
// TOML the user already has, leaving every other key alone. Idempotent.
// ---------------------------------------------------------------------------

const CODEX_TOML_START = "# >>> Pathrule managed (codex hook activation) >>>";
const CODEX_TOML_END = "# <<< Pathrule managed <<<";
const CODEX_TOML_BLOCK = [
  CODEX_TOML_START,
  "[features]",
  "codex_hooks = true",
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
