// SPDX-License-Identifier: Apache-2.0
/**
 * One knowledge item in, at most one proposed RemedyAtom out.
 *
 * This is the production assembly of the pipeline frozen as `REMEDY_PRIMITIVE_V1`:
 *
 *   item text -> local model (compact contract, no adapter)
 *             -> defensive parse
 *             -> exact byte grounding
 *             -> bounded span recovery, only for spans grounding rejected
 *             -> validator (the authority)
 *             -> inferred + proposed atom, or an explicit reason for nothing
 *
 * Two things it deliberately does NOT do. It never stores anything: persistence is the caller's,
 * so this stays pure and testable. And it never returns a bare null, because "the model found no
 * remedy" and "the model could not be reached" are different facts and the second one masquerading
 * as the first is a failure class this project has already paid for.
 */
import {
  REMEDY_COMPACT_SYSTEM,
  parseRemedyExtractionDetailed,
  type EvidenceState,
  type RemedyParseMode,
} from "../knowledge/remedy-extraction.js";
import { recoverSpan } from "../knowledge/remedy-span-recovery.js";
import { validateRemedyInput, type RemedyAtom, type RemedyEvidenceState, type RemedyInput } from "../knowledge/remedy.js";
import { stampProposedRemedy } from "../knowledge/remedy-fingerprint.js";

import type { LocalIntelligenceClient, LocalIntelligenceError } from "./client.js";

/** The knowledge the pipeline reads. Title included: a memory routinely states the problem there. */
export interface RemedySource {
  kind: "memory" | "rule";
  id: string;
  title: string;
  body: string;
  nodePath: string | null;
  /** When the knowledge was recorded, carried onto the atom as provenance. */
  observedAt: string;
}

export type RemedyExtractionOutcome =
  | { status: "proposed"; atom: RemedyAtom; recovered: number; ms: number; parseMode: RemedyParseMode }
  | { status: "no_remedy"; reason: string; ms: number; parseMode: RemedyParseMode }
  | { status: "failed"; error: LocalIntelligenceError | { kind: "invalid_model_output" | "rejected_by_validator"; message: string } };

/** How much of an item the model is shown. Bounded so one huge memory cannot dominate a run. */
const MAX_BODY_CHARS = 1400;

/**
 * The frozen contract answers with its own vocabulary; the atom uses the production one. They
 * carry the same seven states, so this is a rename rather than a mapping, and it is written out
 * so a future divergence is a compile error instead of a silent shrug.
 */
function toEvidenceState(state: EvidenceState): RemedyEvidenceState | null {
  switch (state) {
    case "HUMAN_AUTHORED":
    case "REPEATED_SUCCESS":
    case "OBSERVED_SUCCESS":
    case "SPECULATIVE":
    case "ATTEMPTED":
    case "FAILED":
    case "SUPERSEDED":
      return state;
    case "NONE":
      return null;
    default:
      return null;
  }
}

/**
 * Run the frozen pipeline over one item.
 *
 * `client` is injected rather than constructed so a caller can point at whatever local server
 * the product decides on, and so tests need none.
 */
export async function extractRemedy(
  client: LocalIntelligenceClient,
  source: RemedySource,
  now: string,
): Promise<RemedyExtractionOutcome> {
  const body = source.body.length <= MAX_BODY_CHARS ? source.body : source.body.slice(0, MAX_BODY_CHARS);
  // The title is part of the grounded text, because the corpus put the problem there in 77 of
  // 252 memories. Grounding and the prompt must see exactly the same string.
  const itemText = `${source.title}\n${body}`;
  const user = `Knowledge item.\n\nTitle: ${source.title}\n\n---\n${body}\n---`;

  const res = await client.infer({ system: REMEDY_COMPACT_SYSTEM, user });
  if (!res.ok) return { status: "failed", error: res.error };

  const parsed = parseRemedyExtractionDetailed(res.text);
  const ex = parsed.extraction;
  const parseMode = parsed.mode;
  if (!ex) {
    return {
      status: "failed",
      error: { kind: "invalid_model_output", message: "the model's answer could not be parsed as the REMEDY contract" },
    };
  }
  if (ex.classification === "NONE") {
    return { status: "no_remedy", reason: "the model found no corrective knowledge", ms: res.ms, parseMode };
  }

  const evidenceState = toEvidenceState(ex.evidence_state);
  if (!evidenceState) {
    return { status: "no_remedy", reason: "the model named no evidence state", ms: res.ms, parseMode };
  }

  /**
   * Grounding first, recovery only for what it rejected. Recovery can never widen what counts as
   * grounded: it returns a stretch of the item itself, which is then required to be byte-present
   * like any other span.
   */
  let recovered = 0;
  let droppedActions = 0;
  const ground = (spans: string[], countDrops = false): string[] => {
    const kept: string[] = [];
    for (const span of spans) {
      if (itemText.includes(span)) { kept.push(span); continue; }
      const r = recoverSpan(span, itemText);
      if (r.recovered && !kept.includes(r.span)) { kept.push(r.span); recovered += 1; continue; }
      if (countDrops) droppedActions += 1;
    }
    return kept;
  };

  const input: RemedyInput = {
    variant: ex.classification === "REMEDY_BIND" ? "bind" : "trouble",
    condition_evidence: ground(ex.condition_spans),
    condition_normalized: ex.condition_summary.trim() || null,
    action_evidence: ground(ex.action_spans, true),
    evidence_state: evidenceState,
    source: { kind: source.kind, id: source.id, title: source.title, node_path: source.nodePath },
    observed_at: source.observedAt,
  };

  // The validator is the authority, exactly as it is for a constraint. A refusal here is a
  // legitimate "no remedy", not an error: the model proposed something the source does not
  // support, and abstaining is the designed outcome.
  // Say WHICH kind of nothing this is. Ungroundable spans are dropped before validation, so the
  // validator can only report "no action at all"; that would hide the more useful fact that the
  // model DID name an action and the source does not contain it.
  if (input.action_evidence.length === 0 && droppedActions > 0) {
    return {
      status: "no_remedy",
      reason: `the model named an action that is not present in the source (${droppedActions} span${droppedActions === 1 ? "" : "s"} dropped)`,
      ms: res.ms,
      parseMode,
    };
  }

  const validated = validateRemedyInput(input, itemText);
  if (!validated.ok) {
    return { status: "no_remedy", reason: validated.message, ms: res.ms, parseMode };
  }

  return {
    status: "proposed",
    atom: stampProposedRemedy(validated.value, { now }),
    recovered,
    ms: res.ms,
    parseMode,
  };
}
