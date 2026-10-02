// SPDX-License-Identifier: Apache-2.0
/**
 * CONTEXT atoms: source-backed descriptive FACTS, in production (V32).
 *
 * A CONTEXT tells an agent something true about the code it is working in ("the API package is
 * generated from the OpenAPI schema"). It is descriptive, never normative, and it must NEVER become
 * enforcement.
 *
 * The V31 lesson is applied from the start: FALSE_CONTEXT is SEMANTIC, not grounding. A grounded span
 * that is actually a preference, a prohibition, a requirement, an instruction, or a rationale is a
 * FALSE_CONTEXT even though its words are in the source. The deterministic gates below keep a CONTEXT
 * a plain descriptive fact, and keep a stale/speculative fact from being delivered as a current one.
 * Hard target: FALSE_CONTEXT = 0. Prefer abstention.
 */
import type { ConstraintAuthority } from "./constraint.js";

/**
 * The epistemic status of the fact, read off what the source says. Only CURRENT is deliverable: a
 * fact the source frames as past ("we used X in 2023"), replaced ("switched away"), or speculative
 * ("might be") is stored so a person can see it, and never delivered as present truth.
 */
export type ContextTemporalStatus = "CURRENT" | "HISTORICAL" | "SUPERSEDED" | "SPECULATIVE";
export const CONTEXT_TEMPORAL_STATUSES: readonly ContextTemporalStatus[] = ["CURRENT", "HISTORICAL", "SUPERSEDED", "SPECULATIVE"];
export const DELIVERABLE_CONTEXT_STATUSES: ReadonlySet<ContextTemporalStatus> = new Set<ContextTemporalStatus>(["CURRENT"]);

export type ContextStatus = "proposed" | "active" | "rejected";

export interface ContextInput {
  /** Verbatim fact span(s). At least one is required. */
  fact_evidence: string[];
  /** The extractor's wording. NEVER shown as source evidence. Null when evidence exists. */
  fact_normalized: string | null;
  /** Optional topic/subject the fact is about ("build", "auth"), for relevance. Verbatim or null. */
  topic: string | null;
  temporal_status: ContextTemporalStatus;
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
}

export interface ContextAtom {
  id: string;
  kind: "context";
  fact_evidence: string[];
  fact_normalized: string | null;
  topic: string | null;
  temporal_status: ContextTemporalStatus;
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
  authority: Exclude<ConstraintAuthority, "verified">;
  status: ContextStatus;
  created_at: string;
  approved_by: string | null;
  fingerprint: string;
}

export type ContextValidationCode =
  | "context_no_fact"
  | "context_fact_not_grounded"
  | "context_status_unknown"
  | "context_source_missing"
  | "context_is_preference"
  | "context_is_prohibition"
  | "context_is_mandatory"
  | "context_is_instruction"
  | "context_is_rationale"
  | "context_stale_marked_current";

export type ContextValidation =
  | { ok: true; value: ContextInput }
  | { ok: false; code: ContextValidationCode; message: string };

// A CONTEXT is a DESCRIPTIVE fact. These markers mean the text is really some OTHER primitive.
const PREFERENCE = /\b(prefer(?:s|red|ence)?|defaults?\s+to|default\s+is|recommend(?:ed|s)?|instead\s+of|rather\s+than|favou?rs?)\b/i;
const PROHIBITION = /\b(never|must not|do not|don't|forbidden|banned|prohibited|disallow(?:ed)?)\b/i;
const MANDATORY = /\b(must|shall|ensure|always|required|require[sd]?|need to|has to|have to)\b/i;
// "since" only when causal (not "since 2024"); the rest are unambiguous explanation connectives.
const RATIONALE_MARKER = /\b(because|so that|in order to|due to|the reason|that is why|thereby|to avoid|to prevent)\b|\bsince\b(?!\s+\d)/i;
const IMPERATIVE_START = /^\s*(run|ensure|add|remove|update|use|create|install|configure|set|make sure|do|check|verify|call|import|prefer|avoid|apply|enable|disable|move|rename|delete|write|read)\b/i;
// A fact framed as past / replaced / speculative must not be stamped CURRENT.
const HISTORICAL = /\b(used to|previously|formerly|no longer|deprecated|in \d{4}|back then|historically|switched away|was\s+the)\b/i;
const SPECULATIVE = /\b(might|maybe|probably|perhaps|could be|possibly|we think|seems|likely)\b/i;

/**
 * Validate a CONTEXT against its source text. Byte-exact grounding, plus the semantic gates that keep
 * FALSE_CONTEXT = 0: a fact carrying preference / prohibition / mandatory / imperative / rationale
 * wording is another primitive, not a CONTEXT, and is refused. A fact whose wording is historical or
 * speculative may not be stamped CURRENT.
 */
export function validateContextInput(input: ContextInput, itemText: string): ContextValidation {
  if (!input.source?.id) return { ok: false, code: "context_source_missing", message: "A context must name its source." };
  if (!CONTEXT_TEMPORAL_STATUSES.includes(input.temporal_status)) return { ok: false, code: "context_status_unknown", message: `Unknown temporal status ${String(input.temporal_status)}.` };
  const facts = input.fact_evidence.filter((s) => s.trim().length > 0);
  if (facts.length === 0) return { ok: false, code: "context_no_fact", message: "A context must state a fact." };
  const ungrounded = facts.find((s) => !itemText.includes(s));
  if (ungrounded) return { ok: false, code: "context_fact_not_grounded", message: `The fact is not present in the source: ${JSON.stringify(ungrounded.slice(0, 60))}` };

  const all = facts.join(" ");
  if (PREFERENCE.test(all)) return { ok: false, code: "context_is_preference", message: "A preference is a SELECTION, not a CONTEXT." };
  if (PROHIBITION.test(all)) return { ok: false, code: "context_is_prohibition", message: "A prohibition is a CONSTRAINT, not a CONTEXT." };
  if (MANDATORY.test(all)) return { ok: false, code: "context_is_mandatory", message: "A requirement is a CONSTRAINT or CHECK, not a CONTEXT." };
  if (facts.some((s) => IMPERATIVE_START.test(s))) return { ok: false, code: "context_is_instruction", message: "An instruction is a REMEDY/PROCEDURE, not a CONTEXT." };
  if (RATIONALE_MARKER.test(all)) return { ok: false, code: "context_is_rationale", message: "An explanation is a RATIONALE, not a bare CONTEXT." };

  // Stale-fact guard: wording that is clearly past/replaced/speculative cannot be CURRENT.
  if (input.temporal_status === "CURRENT" && (HISTORICAL.test(all) || SPECULATIVE.test(all))) {
    return { ok: false, code: "context_stale_marked_current", message: "A historical or speculative fact must not be marked CURRENT." };
  }
  return { ok: true, value: { ...input, fact_evidence: facts } };
}

export function approveContext(atom: ContextAtom, approvedBy: string): ContextAtom {
  return { ...atom, authority: "human", status: "active", approved_by: approvedBy };
}
export function rejectContext(atom: ContextAtom, rejectedBy: string): ContextAtom {
  return { ...atom, authority: "inferred", status: "rejected", approved_by: rejectedBy };
}

/** Would this reach an agent? A person approved it, it is active, and the source frames it as CURRENT. */
export function isContextDeliverable(atom: ContextAtom): boolean {
  return atom.authority === "human" && atom.status === "active" && DELIVERABLE_CONTEXT_STATUSES.has(atom.temporal_status);
}

const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

export function parseContextAtom(raw: unknown): ContextAtom | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o["kind"] !== "context") return null;
  const status = o["status"];
  if (status !== "proposed" && status !== "active" && status !== "rejected") return null;
  const authority = o["authority"];
  if (authority !== "human" && authority !== "inferred") return null;
  const temporal = o["temporal_status"];
  if (typeof temporal !== "string" || !CONTEXT_TEMPORAL_STATUSES.includes(temporal as ContextTemporalStatus)) return null;
  const src = o["source"];
  if (!src || typeof src !== "object") return null;
  const s = src as Record<string, unknown>;
  if ((s["kind"] !== "memory" && s["kind"] !== "rule") || typeof s["id"] !== "string") return null;
  const facts = asStringArray(o["fact_evidence"]);
  if (facts.length === 0) return null;
  const id = typeof o["id"] === "string" ? o["id"] : null;
  const fingerprint = typeof o["fingerprint"] === "string" ? o["fingerprint"] : id;
  if (!id || !fingerprint) return null;
  return {
    id, kind: "context", fact_evidence: facts,
    fact_normalized: typeof o["fact_normalized"] === "string" ? o["fact_normalized"] : null,
    topic: typeof o["topic"] === "string" ? o["topic"] : null,
    temporal_status: temporal as ContextTemporalStatus,
    source: { kind: s["kind"], id: s["id"], title: typeof s["title"] === "string" ? s["title"] : "", node_path: typeof s["node_path"] === "string" ? s["node_path"] : null },
    observed_at: typeof o["observed_at"] === "string" ? o["observed_at"] : "",
    authority, status,
    created_at: typeof o["created_at"] === "string" ? o["created_at"] : "",
    approved_by: typeof o["approved_by"] === "string" ? o["approved_by"] : null,
    fingerprint,
  };
}
