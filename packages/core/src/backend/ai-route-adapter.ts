// SPDX-License-Identifier: Apache-2.0
// BYO ("bring your own key") ai-route adapter.
//
// Routing works networklessly by default — the deterministic router stays the
// default — but a developer who exports `PATHRULE_AI_ROUTE_KEY` can opt into an
// LLM router that calls their own Anthropic key directly.
//
// This module is pure (no SQLite, no network deps) so the SQLite-backed and
// in-memory backends share it. It ships a lean routing prompt (below).
//
// Contract: returns a RoutingResult (decision + latency, or a `fallback` reason)
// when a key is present; returns `null` when no key is configured, so the caller
// knows the capability is unwired and falls back to the deterministic router.

import type {
  RouteIntentInput,
  RoutingDecision,
  RoutingNext,
  RoutingResult,
  TaskShape,
  ContextDepth,
  ResponseSection,
} from "@pathrule/shared/routing-types.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 400;
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_TIMEOUT_MS = 5000;

// Routing prompt. Follows the routing decision *schema* (so the existing
// merge/shaping logic works unchanged).
export const OSS_ROUTER_PROMPT = `You are the routing director for Pathrule's get_context tool.
Given a developer's intent plus a compact summary of their workspace (paths, memory
titles, rule + skill names) and their recent activity, decide what the calling AI
assistant should do next. Reply with ONLY a single JSON object — no prose, no code
fences — matching exactly this shape:

{
  "next": one of "read_memory" | "edit_known_path" | "execute_only" | "answer_directly" | "no_action",
  "reason": short string (<= 200 chars) explaining the choice,
  "confidence": "high" | "low",
  "memory_id": (optional) a memory UUID from workspace_overview when next = "read_memory",
  "task_shape": (optional) one of "ui_tweak" | "new_feature" | "bug_fix" | "refactor" | "debug" | "discovery" | "unknown",
  "context_depth": (optional) "minimal" | "focused" | "deep",
  "primary_files": (optional) up to 6 workspace-relative file paths to edit, ONLY when confidence is "high" and task_shape is ui_tweak/new_feature/bug_fix/refactor,
  "include": (optional) up to 8 of "hot_paths" | "recent_activities" | "prior_solutions" | "prior_work" | "coupled_nodes" | "workspace_overview" | "preload_memory:<uuid>"
}

Guidance:
- "read_memory" when a specific memory clearly answers the intent (set memory_id).
- "edit_known_path" when the target file/area is identifiable (set primary_files, task_shape, context_depth).
- "execute_only" for a mechanical task needing no extra context.
- "answer_directly" when the intent is a question answerable from the summary.
- "no_action" when nothing in the workspace is relevant.
- Prefer "minimal"/"focused" depth for narrow tasks; "deep" only for debugging or discovery.
- Be conservative: emit "low" confidence (and omit primary_files) when unsure.`;

const NEXT_VALUES: readonly RoutingNext[] = [
  "read_memory",
  "execute_only",
  "edit_known_path",
  "answer_directly",
  "no_action",
  "call_understand",
];
const TASK_SHAPES: readonly TaskShape[] = [
  "ui_tweak",
  "new_feature",
  "bug_fix",
  "refactor",
  "debug",
  "discovery",
  "unknown",
];
const CONTEXT_DEPTHS: readonly ContextDepth[] = ["minimal", "focused", "deep"];
const SECTION_VALUES = new Set([
  "hot_paths",
  "recent_activities",
  "prior_solutions",
  "prior_work",
  "coupled_nodes",
  "workspace_overview",
]);

/** Injectable seam — defaults to global fetch; tests pass a deterministic stub. */
export interface AiRouteAdapterOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Extract the first balanced JSON object from a model reply, tolerating code
 * fences and surrounding prose.
 */
export function extractJsonObject(text: string): unknown | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    for (let i = start; i < stripped.length; i += 1) {
      const ch = stripped[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(stripped.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateInclude(value: unknown): ResponseSection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ResponseSection[] = [];
  for (const raw of value.slice(0, 8)) {
    if (typeof raw !== "string") continue;
    if (SECTION_VALUES.has(raw)) {
      out.push(raw as ResponseSection);
    } else if (
      raw.startsWith("preload_memory:") &&
      UUID_RE.test(raw.slice("preload_memory:".length))
    ) {
      out.push(raw as ResponseSection);
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Hand-rolled validator for the routing decision shape, without a runtime
 * schema dependency. Returns null on any hard violation (missing/invalid `next`
 * or `confidence`); tolerates absent optionals.
 */
export function validateRoutingDecision(obj: unknown): RoutingDecision | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  const next = o.next;
  if (typeof next !== "string" || !NEXT_VALUES.includes(next as RoutingNext)) return null;
  const confidence = o.confidence;
  if (confidence !== "high" && confidence !== "low") return null;

  const decision: RoutingDecision = {
    next: next as RoutingNext,
    reason: typeof o.reason === "string" ? o.reason.slice(0, 200) : "",
    confidence,
  };

  if (typeof o.memory_id === "string" && UUID_RE.test(o.memory_id)) {
    decision.memory_id = o.memory_id;
  }
  if (typeof o.task_shape === "string" && TASK_SHAPES.includes(o.task_shape as TaskShape)) {
    decision.task_shape = o.task_shape as TaskShape;
  }
  if (
    typeof o.context_depth === "string" &&
    CONTEXT_DEPTHS.includes(o.context_depth as ContextDepth)
  ) {
    decision.context_depth = o.context_depth as ContextDepth;
  }
  if (Array.isArray(o.primary_files)) {
    const files = o.primary_files
      .filter((f): f is string => typeof f === "string")
      .slice(0, 6)
      .map((f) => f.slice(0, 300));
    if (files.length > 0) decision.primary_files = files;
  }
  const include = validateInclude(o.include);
  if (include) decision.include = include;

  return decision;
}

function buildUserPayload(input: RouteIntentInput): string {
  return JSON.stringify({
    user_intent: input.userIntent,
    workspace_overview: input.workspaceOverview,
    recent_activities: input.recentActivities,
  });
}

async function callProvider(opts: {
  apiKey: string;
  model: string;
  userPayload: string;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  retryOf?: string;
}): Promise<string> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [
    { role: "user", content: opts.userPayload },
  ];
  if (opts.retryOf) {
    messages.push({ role: "assistant", content: opts.retryOf });
    messages.push({
      role: "user",
      content:
        "Your previous reply was not valid JSON matching the routing schema. Reply again with ONLY the JSON object, no preamble, no code fences.",
    });
  }

  const res = await opts.fetchImpl(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: MAX_TOKENS,
      system: OSS_ROUTER_PROMPT,
      messages,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    throw new Error(`anthropic ${res.status}`);
  }
  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return (json.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/**
 * Run the BYO LLM router. `null` ⇒ no key configured (capability unwired). A
 * RoutingResult with `decision` ⇒ success; with `fallback` ⇒ a soft failure the
 * caller maps to the deterministic router (never throws).
 */
export async function runAiRouteAdapter(
  input: RouteIntentInput,
  options: AiRouteAdapterOptions = {},
): Promise<RoutingResult | null> {
  const apiKey = options.apiKey ?? process.env.PATHRULE_AI_ROUTE_KEY;
  if (!apiKey) return null;

  const model = options.model ?? process.env.PATHRULE_AI_ROUTE_MODEL ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userPayload = buildUserPayload(input);

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  // Each attempt gets its OWN AbortController, bounded by the SHARED deadline (so the
  // two attempts together can't exceed the total budget). A single shared controller
  // would let the retry fetch against an already-fired signal whenever the first
  // attempt ran near the deadline — aborting instantly and masking a real retry.
  const attempt = async (retryOf?: string): Promise<string> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const e = new Error("deadline exceeded");
      e.name = "AbortError";
      throw e;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      return await callProvider({
        apiKey,
        model,
        userPayload,
        signal: controller.signal,
        fetchImpl,
        retryOf,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let text = await attempt();
    let decision = validateRoutingDecision(extractJsonObject(text));

    if (!decision) {
      // One strict-reminder retry. A timeout inside the retry surfaces as
      // AbortError → edge_timeout; only a genuine non-timeout retry failure
      // falls through to parse_failure.
      try {
        text = await attempt(text);
        decision = validateRoutingDecision(extractJsonObject(text));
      } catch (retryErr) {
        if (retryErr instanceof Error && retryErr.name === "AbortError") {
          return { fallback: "edge_timeout", latency_ms: Date.now() - startedAt };
        }
        // fall through to parse_failure
      }
    }

    if (!decision) {
      return { fallback: "parse_failure", latency_ms: Date.now() - startedAt };
    }
    return { decision, latency_ms: Date.now() - startedAt };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { fallback: "edge_timeout", latency_ms: Date.now() - startedAt };
    }
    return { fallback: "edge_error", latency_ms: Date.now() - startedAt };
  }
}

/** True when a BYO router key is present — drives capabilities().routerLLM. */
export function hasAiRouteKey(): boolean {
  return !!process.env.PATHRULE_AI_ROUTE_KEY;
}
