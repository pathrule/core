// Hook Supervisor type definitions.
//
// Includes RuleInjectionStrategy, CandidateRule, SelectInjectedRulesInput/Output.
//
// Two sides of the hook protocol:
//   1. HookEventInput  — JSON that Claude Code pipes into the hook script's stdin
//   2. HookEventOutput — JSON the hook script writes to stdout; controls Claude
//
// And the cache shape:
//   3. HookIndex — the JSON file pre-computed at
//      ~/.pathrule/cache/<workspace_id>/hook-index.json that the shell script
//      reads on the hot path (no network, no database).

// ─────────────────────────────────────────────────────────────────────────────
// 1. Input — what Claude Code sends to the hook
// ─────────────────────────────────────────────────────────────────────────────

export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "UserPromptSubmit"
  | "SessionStart"
  | "SessionEnd"
  | "Stop"
  | "SubagentStop"
  | "Notification"
  | "PreCompact"
  | "PostCompact";

/** Fields common to every hook event. */
export interface HookEventCommon {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: HookEventName;
  /** Present when a Stop hook fires recursively — short-circuit to avoid loops. */
  stop_hook_active?: boolean;
}

/** PreToolUse / PostToolUse events carry tool call details. */
export interface HookEventToolCall extends HookEventCommon {
  hook_event_name: "PreToolUse" | "PostToolUse";
  tool_name: string;
  /** Tool-specific args. For Read/Edit/Write: `file_path`. For Bash: `command`. */
  tool_input: Record<string, unknown>;
  /** PostToolUse only — result of tool execution. */
  tool_response?: {
    is_error?: boolean;
    content?: unknown;
    [k: string]: unknown;
  };
}

/** UserPromptSubmit carries the user's raw prompt text. */
export interface HookEventUserPrompt extends HookEventCommon {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export type HookEventInput = HookEventToolCall | HookEventUserPrompt | HookEventCommon;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Output — what the hook writes to stdout; controls Claude
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Output schema accepted by Claude Code on hook stdout (exit 0 required).
 *
 * Design rule for Pathrule: ALWAYS exit 0, never exit 2. Encode block
 * decisions inside the JSON (`decision: "deny"`) so we only have one output
 * path to reason about.
 */
export interface HookEventOutput {
  /** If false, Claude aborts the current turn. Rarely needed. */
  continue?: boolean;
  /** Block / allow / ask the current operation. "deny" blocks PreToolUse. */
  decision?: "block" | "allow" | "ask" | "deny" | "defer";
  /** Human-readable justification shown to Claude when blocking. */
  reason?: string;
  /** One-line message printed to user UI (not to Claude). */
  systemMessage?: string;
  /** Suppress stdout from being treated as added context. */
  suppressOutput?: boolean;
  hookSpecificOutput?: {
    hookEventName?: HookEventName;
    /**
     * Text injected into Claude's context. Up to ~10,000 chars — Pathrule
     * keeps injections well under 1,000 chars to avoid polluting context.
     */
    additionalContext?: string;
    permissionDecision?: "allow" | "deny" | "ask" | "defer";
    permissionDecisionReason?: string;
    /** For PreToolUse — rewrite the tool args before execution. */
    updatedInput?: Record<string, unknown>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical hook config (shared by Claude + Cursor adapters)
// ─────────────────────────────────────────────────────────────────────────────

export interface HookCommand {
  type?: "command";
  command: string;
  timeout?: number;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export interface HookConfig {
  hooks: Partial<Record<HookEventName, HookMatcher[]>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Cache — hook-index.json
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryStub {
  id: string;
  title: string;
  /** First ~100 chars of memory.content — enough for Claude to decide whether to `read_memory` for full body. */
  preview: string;
  node_path: string;
  /**
   * Filename tokens extracted from the title at build time (e.g. ["loyalty.json"]).
   * Absent when the title contains no filename pattern.
   */
  filename_tokens?: string[];
  /**
   * Full memory body, populated ONLY for filename-indexed stubs whose content
   * fits the per-body cap (3KB). Absent otherwise (hook nudges Claude to call
   * pathrule_read_memory for the canonical version).
   */
  body?: string;
  /** sha256(content) prefix — change-detection key for delta injection. */
  content_hash?: string;
  /** Internal scoring tags derived at index build time. Not shown in the app UI. */
  semantic_tags?: string[];
}

export interface HookSemanticCandidate {
  id: string;
  title: string;
  node_path: string;
  confidence: "high" | "medium";
  reason?: string;
}

export interface RuleStub {
  id: string;
  name: string;
  scope_type: "folder" | "file_type" | "project";
  priority: "high" | "medium" | "low";
  /** When 'strict', hook can emit `decision: "deny"` on violation. */
  enforcement?: "strict" | "advisory";
  preview: string;
  node_path?: string;
  /**
   * Extracted at index build time from rule.content when the body
   * contains a `BLOCK_PATTERN: /regex/flags` marker. Hook script tests this
   * regex against tool_input (new_string / content / command) and denies on
   * match. Only populated when `enforcement === 'strict'`.
   */
  block_pattern?: { source: string; flags: string };
  /**
   * Explicit API / symbol markers the rule actually talks about.
   * Auto-extracted from markdown inline-code (`` `foo.bar` ``) at index build
   * time, capped at 8 per rule. If populated, the hook requires at least one
   * literal substring hit against the tool input before injecting — priority
   * independent. If empty/missing, falls back to keyword-token relevance.
   */
  symbols?: string[];
  /** sha256(content) prefix — change-detection key for delta injection. */
  content_hash?: string;
  /** Internal scoring tags derived at index build time. Not shown in the app UI. */
  semantic_tags?: string[];
}

// Path-scoped skill stub (mirrors MemoryStub) so the hook can find a
// routed path's skills and rank them against the prompt for top-k body delivery.
export interface SkillStub {
  id: string;
  name: string;
  node_path: string;
  preview: string;
  content_hash?: string;
}

export interface SkillInvocationStub {
  id: string;
  name: string;
  source: "manual" | "template" | "github_ref";
  github_url: string | null;
  node_path: string | null;
  preview: string;
  body?: string;
  /** sha256(content) prefix — change-detection key for delta injection. */
  content_hash?: string;
  /** Internal scoring tags derived from skill tags + content. Not shown in companion files. */
  semantic_tags?: string[];
}

export interface FailPatternStub {
  /** SHA-ish hash of the error signature — stable key for a recurring failure. */
  signature: string;
  /** Glob of paths where this failure repeats (e.g. "/apps/mobile/**\/*.tsx"). */
  path_glob: string;
  count: number;
  last_seen: string;
  /** Short text to surface to Claude in additionalContext ("Last 3 Edits here failed with X"). */
  warning_text: string;
}

export interface WorkEpisodeStub {
  id: string;
  title: string;
  summary: string;
  subjects: string[];
  paths: string[];
  activity_count: number;
  started_at: string;
  ended_at: string;
  confidence: "low" | "medium" | "high";
}

export interface HookIndex {
  /** Schema version — bump when breaking changes. Shell script checks this. */
  schema_version: 1 | 2;
  workspace_id: string;
  workspace_root: string;
  generated_at: string;

  /** Map: node_path → memories tagged at that path. Lookup walks parent chain. */
  path_memories: Record<string, MemoryStub[]>;
  /** Path-scoped skills (mirrors path_memories) for relevance top-k. */
  path_skills?: Record<string, SkillStub[]>;
  /** Map: node_path → rules scoped to that path. */
  path_rules: Record<string, RuleStub[]>;

  /** Rules with scope_type='project' — relevant for every tool call. */
  project_rules: RuleStub[];

  /** Top subjects from activity logs (last 30 days, max 100) — used by Bloom-style pre-gate. */
  recent_subjects: string[];

  /** Short human-readable summary of last 30min activity. Null if no activity. */
  session_digest: string | null;

  /** Refresh queue counts are prompt-gated by the hook; not automatically injected. */
  pending_refresh_count?: number;
  in_progress_refresh_count?: number;

  /**
   * Native Knowledge Compilation: true when this workspace's knowledge has
   * been compiled into per-directory native instruction files (CLAUDE.md /
   * AGENTS.md / Cursor / Copilot). The hook then stops injecting memory
   * content on PreToolUse (the agent already sees it at turn zero) and keeps
   * only guard (strict deny) + live-delta duties.
   */
  knowledge_compiled?: boolean;
  /** Memory ids whose BODY is in the FULL compiled file — full clients skip these in delta injection. */
  compiled_memory_ids?: string[];

  /**
   * Slim (router) projection ids. For clients with a prompt-time body
   * channel (Claude), the per-dir file carries memory/skill TITLES, not bodies;
   * the hook delivers the prompt-relevant bodies. `indexed_memory_ids` are the
   * title-only memories (their bodies are eligible for hook top-k injection),
   * and `compiled_rule_ids` are rules whose FULL body is already in that slim
   * file (so the hook must NOT re-inject them — rules are floored, turn-zero).
   * Empty/absent when no slim render exists.
   */
  indexed_memory_ids?: string[];
  compiled_rule_ids?: string[];

  /**
   * Navigation Engine: most-touched paths from recent activity (top ~8),
   * derived at index build time. A routing signal: "the team works here".
   */
  hot_paths?: Array<{ path: string; count: number }>;

  /** Populated when failures recur. */
  fail_patterns?: FailPatternStub[];

  /** Compact, local-only prior work candidates for `++history`. */
  work_episode_index?: WorkEpisodeStub[];

  /**
   * Reverse lookup from filename token (e.g. "loyalty.json") to
   * memory_ids whose titles mention that filename. Populated at build time
   * via the index builder's filename detection regex. Hook uses this at
   * UserPromptSubmit time to decide whether to inject a full body inline.
   */
  filename_index?: Record<string, string[]>;

  /**
   * Explicit ::skill-name invocation index. Keys are normalized skill names.
   * Values contain every matching workspace skill so duplicates fail closed.
   */
  skill_invocation_index?: Record<string, SkillInvocationStub[]>;

  /**
   * SHA-256 (16-char truncated) of the current promoted_rules bundle
   * rendered into the per-client instruction files. Attached to every hook
   * payload so the agent can verify CLAUDE.md freshness.
   * NULL when no rules are promoted.
   */
  promoted_rules_signature?: string | null;

  /**
   * Feature flags from the workspace config. The hook script reads
   * `experiments.rule_promotion_v1` to gate injection_strategy behavior.
   */
  experiments?: Record<string, boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule injection strategy types
// ─────────────────────────────────────────────────────────────────────────────

/** Per-rule injection strategy stored in rules.injection_strategy. */
export type RuleInjectionStrategy = "per_call" | "session_once" | "claude_md_only";

/**
 * A rule candidate passed into selectInjectedRules(). Extends the
 * existing RuleStub with the injection_strategy column.
 */
export interface CandidateRule {
  rule_id: string;
  workspace_id: string;
  name: string;
  body: string;
  scope_type: "project" | "folder" | "file_type";
  priority: "critical" | "high" | "medium" | "low";
  injection_strategy: RuleInjectionStrategy;
}

/** Input to selectInjectedRules(). */
export interface SelectInjectedRulesInput {
  session_id: string;
  candidates: CandidateRule[];
  /** Feature flag: pathrule.experiments.rule_promotion_v1. When false, every rule behaves as per_call. */
  promotion_enabled: boolean;
}

/** Output from selectInjectedRules(). */
export interface SelectInjectedRulesOutput {
  injected: CandidateRule[];
  breakdown: {
    per_call: number;
    session_once: number;
    session_once_skipped: number;
    claude_md_only_skipped: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Localhost server contract (cold path)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Config the Electron main process exposes so the shell script can find the
 * cold-path server. Written to `~/.pathrule/cache/supervisor.json` at app
 * start. Bearer token is mirrored in keychain for the hook to pick up via
 * env (`PATHRULE_HOOK_TOKEN`).
 */
export interface SupervisorConfig {
  port: number;
  /** Opaque token — hook authenticates with `Authorization: Bearer <token>`. */
  token_env: "PATHRULE_HOOK_TOKEN";
  started_at: string;
}

/** Status surfaced via IPC for a Settings → Hooks panel. */
export interface HookSupervisorStatus {
  running: boolean;
  port: number | null;
  startedAt: string | null;
}
