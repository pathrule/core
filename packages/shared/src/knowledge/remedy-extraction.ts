// SPDX-License-Identifier: Apache-2.0
/**
 * The REMEDY extraction contract and its defensive parser, shared by production and the frozen
 * benchmark.
 *
 * Moved here from the benchmark when REMEDY became a production primitive. The frozen eval now
 * verifies the exact strings and the exact parser that ship, which is the strongest form the
 * guarantee can take: a second copy is a second thing to drift.
 *
 * These semantics are frozen as REMEDY_PRIMITIVE_V1. Changing the contract string changes what
 * the model is asked, and the frozen numbers stop meaning anything.
 */
import { asString, asStrings, recoverContractObject } from "./remedy-json.js";

/**
 * The COMPACT contract, for a fine-tuned adapter.
 *
 * Measured, and the reason this exists: the verbose contract above is 749 tokens on its own, so
 * a REMEDY training row runs 1186 tokens median and 1297 at the tail. The safe M4 envelope is
 * `max_seq_length` 640, where v7 already peaked at 14.7 GB against a 15.6 GB driver limit.
 * Doubling the sequence to fit the prose would push training into the memory region that
 * kernel-panicked the M1, so the prose cannot come along.
 *
 * That is not a compromise, it is what fine-tuning is FOR: the decision procedure moves into
 * the weights instead of being re-read on every call. v7's staged extraction contract is
 * compact for the same reason and the model learned the behaviour from data.
 *
 * Both contracts are kept, because they serve different deployments: the verbose one is what a
 * base model needs zero-shot (it bought precision 0.62 -> 0.75), and the compact one is what a
 * trained adapter is served. Any comparison has to hold the contract fixed, so the base model
 * is re-baselined on THIS string before any training claim is made.
 */
export const REMEDY_COMPACT_SYSTEM = `Classify one knowledge item's corrective content. JSON only:
{"classification":"REMEDY_BIND|REMEDY_TROUBLE|NONE","condition_spans":[],"condition_summary":"","action_spans":[],"evidence_state":"..."}

REMEDY_BIND: rules out something and names a different mechanism to use instead.
REMEDY_TROUBLE: records something that went wrong and the action that addressed it.
NONE: everything else, including a description of how the system works, a bare prohibition, a
verification, an ordered workflow, a preference, or an explanation.

Spans are copied VERBATIM. Use condition_summary only when the condition cannot be quoted.
evidence_state: HUMAN_AUTHORED|REPEATED_SUCCESS|OBSERVED_SUCCESS|SPECULATIVE|ATTEMPTED|FAILED|SUPERSEDED, on what the item says. Never upgrade it. NONE items use "NONE".`;

export type RemedyClass = "REMEDY_BIND" | "REMEDY_TROUBLE" | "NONE";
export type EvidenceState =
  | "HUMAN_AUTHORED" | "REPEATED_SUCCESS" | "OBSERVED_SUCCESS"
  | "SPECULATIVE" | "ATTEMPTED" | "FAILED" | "SUPERSEDED" | "NONE";

export interface RemedyExtraction {
  classification: RemedyClass;
  condition_spans: string[];
  condition_summary: string;
  action_spans: string[];
  evidence_state: EvidenceState;
}

/** The contract's field names. The recovery scanner uses them as structural landmarks. */
export const REMEDY_CONTRACT_KEYS = [
  "classification",
  "condition_spans",
  "condition_summary",
  "action_spans",
  "evidence_state",
] as const;

const STATES: readonly EvidenceState[] = [
  "HUMAN_AUTHORED", "REPEATED_SUCCESS", "OBSERVED_SUCCESS",
  "SPECULATIVE", "ATTEMPTED", "FAILED", "SUPERSEDED", "NONE",
];

/**
 * Bounded rescue for output that is not valid JSON.
 *
 * Measured on the frozen eval: 11 of 47 answers land here, and on real workspace memories 10 of
 * 20. Two families, neither semantic. Seven leave an array unclosed and jump straight to the
 * next key; four quote source text that itself contains a raw `"`. Discarding all of them would
 * throw away right answers over a missing `]`.
 *
 * The scanning lives in `remedy-json.ts`, which reads JSON string semantics properly instead of
 * pairing quote characters. That distinction is the whole point: the old regex read an internal
 * quote as a terminator, so one intended span became two fragments, and the leading fragment was
 * still byte-present in the source and therefore passed exact grounding. The parser was handing
 * grounding a shredded input and grounding was faithfully accepting it.
 *
 * Rescue stays safe for the same reasons it always did, none of them weakened: the two enum
 * fields are validated against closed sets, nothing is invented, evidence text is never
 * rewritten, and every recovered span still has to be byte-present in the item before it can
 * become evidence. If the classification cannot be read, this returns null and the item is a
 * genuine parse failure rather than an empty result.
 */
function salvage(text: string): RemedyExtraction | null {
  const recovered = recoverContractObject(text, REMEDY_CONTRACT_KEYS);
  if (!recovered) return null;
  const cls = asString(recovered.fields.get("classification"));
  if (cls !== "REMEDY_BIND" && cls !== "REMEDY_TROUBLE" && cls !== "NONE") return null;
  const st = asString(recovered.fields.get("evidence_state")) as EvidenceState;
  return {
    classification: cls,
    condition_spans: asStrings(recovered.fields.get("condition_spans")),
    condition_summary: asString(recovered.fields.get("condition_summary")),
    action_spans: asStrings(recovered.fields.get("action_spans")),
    evidence_state: STATES.includes(st) ? st : "NONE",
  };
}

/**
 * Which route a parse took.
 *
 * Reported rather than inferred, because "how often does salvage run" is the question that
 * decides whether it is still a rare emergency path or has quietly become the parser. Before
 * this existed the only way to answer it was to re-parse the raw text outside the pipeline,
 * which is a second implementation and therefore a second thing to be wrong.
 */
export type RemedyParseMode = "json" | "salvage" | "failed";

export interface RemedyParseResult {
  extraction: RemedyExtraction | null;
  mode: RemedyParseMode;
}

/** Defensive parse. Malformed model output must fail cleanly, never crash the harness. */
export function parseRemedyExtraction(text: string): RemedyExtraction | null {
  return parseRemedyExtractionDetailed(text).extraction;
}

/** The same parse, reporting which route it took. */
export function parseRemedyExtractionDetailed(text: string): RemedyParseResult {
  const salvaged = (t: string): RemedyParseResult => {
    const extraction = salvage(t);
    return { extraction, mode: extraction ? "salvage" : "failed" };
  };
  /**
   * The whole answer first, the fenced slice only as a fallback.
   *
   * This order is load-bearing. Stripping a fence first looks harmless because a fence, when the
   * model uses one, sits OUTSIDE the braces, so `indexOf("{")` finds the object either way.
   * Reading the fence first is what breaks: the corpus is full of memories that contain markdown
   * code fences, and when the model quotes one verbatim into a span the regex matches the fence
   * INSIDE the JSON string. Measured on eval item r39, where it kept 220 characters of a quoted
   * CSS block and discarded a complete, valid 1855-character answer, which was then recorded as
   * a parse failure.
   */
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]!.trim());

  let o: Record<string, unknown> | null = null;
  let c = candidates[0]!;
  for (const candidate of candidates) {
    const i = candidate.indexOf("{"), j = candidate.lastIndexOf("}");
    if (i < 0 || j <= i) continue;
    try {
      o = JSON.parse(candidate.slice(i, j + 1)) as Record<string, unknown>;
      c = candidate;
      break;
    } catch {
      c = candidate;
    }
  }
  if (!o) return salvaged(c);
  const cls = o["classification"];
  // Well-formed JSON that is not the contract. Salvage cannot help: it looks for the same
  // classification key this object already failed to carry.
  if (cls !== "REMEDY_BIND" && cls !== "REMEDY_TROUBLE" && cls !== "NONE") {
    return { extraction: null, mode: "failed" };
  }
  /**
   * A bare STRING is accepted where the schema asks for an array of spans, and wrapped.
   *
   * Measured, not assumed: on the frozen REMEDY eval the base model classified 7 items
   * correctly and then returned `action_spans` as one string. The first version of this parser
   * coerced a non-array to `[]`, so the right content was thrown away and the run recorded 7
   * "no action offered" failures that looked like a capability gap. They were a shape mismatch.
   *
   * This repo has now hit that class four times (see the design-motion spec parser). The
   * standing lesson applies: when the model emits a reasonable schema, make the INGEST tolerant
   * rather than only tightening the prompt. Tolerance is safe here because the span still has
   * to be byte-present in the item before it can become evidence.
   */
  const arr = (v: unknown): string[] => {
    if (typeof v === "string") return v.trim() ? [v] : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  };
  const STATES: EvidenceState[] = ["HUMAN_AUTHORED", "REPEATED_SUCCESS", "OBSERVED_SUCCESS", "SPECULATIVE", "ATTEMPTED", "FAILED", "SUPERSEDED", "NONE"];
  const st = o["evidence_state"];
  return {
    mode: "json",
    extraction: {
      classification: cls,
      condition_spans: arr(o["condition_spans"]),
      condition_summary: typeof o["condition_summary"] === "string" ? o["condition_summary"] : "",
      action_spans: arr(o["action_spans"]),
      evidence_state: STATES.includes(st as EvidenceState) ? (st as EvidenceState) : "NONE",
    },
  };
}
