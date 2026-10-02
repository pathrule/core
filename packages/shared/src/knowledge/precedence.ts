// SPDX-License-Identifier: Apache-2.0
/**
 * PRECEDENCE atoms: source-backed AUTHORITY relationships, in production (V33).
 *
 * A PRECEDENCE says "under this scope/condition, knowledge A takes precedence over knowledge B". It is
 * the one primitive that lets Pathrule resolve a conflict between two otherwise-valid pieces of
 * knowledge, so it is the highest-risk one: a wrong edge silently suppresses correct knowledge.
 *
 * The V31 lesson is law here: FALSE_PRECEDENCE is SEMANTIC. Grounding the words is not enough; the
 * source must actually EXPRESS that one side overrides the other. Adjacency ("we use X in web and Y in
 * api"), recency ("previously X, now Y"), and confidence do NOT imply precedence. Only an explicit
 * override/supersedes/takes-precedence relationship does. When precedence cannot be proven the compiler
 * withholds; this atom never guesses. Hard target: FALSE_PRECEDENCE = 0.
 */
import { createHash } from "node:crypto";

import type { ConstraintAuthority } from "./constraint.js";

export type PrecedenceStatus = "proposed" | "active" | "rejected";

export interface PrecedenceInput {
  /** The side that wins, source-verbatim. At least one required. */
  winner_evidence: string[];
  winner_normalized: string | null;
  /** The side that loses, source-verbatim. At least one required. */
  loser_evidence: string[];
  loser_normalized: string | null;
  /** The span that EXPRESSES the override (verbatim), e.g. "the repo rule overrides the org default". */
  relationship_evidence: string[];
  /** Optional condition/context under which the precedence holds. Never source evidence. */
  condition_normalized: string | null;
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
}

export interface PrecedenceAtom {
  id: string;
  kind: "precedence";
  winner_evidence: string[];
  winner_normalized: string | null;
  loser_evidence: string[];
  loser_normalized: string | null;
  relationship_evidence: string[];
  condition_normalized: string | null;
  source: { kind: "memory" | "rule"; id: string; title: string; node_path: string | null };
  observed_at: string;
  authority: Exclude<ConstraintAuthority, "verified">;
  status: PrecedenceStatus;
  created_at: string;
  approved_by: string | null;
  fingerprint: string;
}

export type PrecedenceValidationCode =
  | "precedence_no_winner"
  | "precedence_no_loser"
  | "precedence_winner_not_grounded"
  | "precedence_loser_not_grounded"
  | "precedence_winner_equals_loser"
  | "precedence_no_relationship"
  | "precedence_no_override_language"
  | "precedence_source_missing";

export type PrecedenceValidation =
  | { ok: true; value: PrecedenceInput }
  | { ok: false; code: PrecedenceValidationCode; message: string };

export function precedenceFingerprint(input: { winner_evidence: string[]; loser_evidence: string[]; source: { kind: string; id: string } }): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const parts = [
    input.source.kind, input.source.id,
    [...input.winner_evidence].map(norm).sort().join(""),
    [...input.loser_evidence].map(norm).sort().join(""),
  ];
  return createHash("sha256").update(parts.join(" ")).digest("hex");
}

/**
 * Explicit precedence language. Its presence is what makes a superiority relationship SUPPORTED. It is
 * deliberately narrow: "instead of" is a SELECTION, "newer/now/previously" is recency, "more confident"
 * is confidence, none of which are precedence.
 */
export const OVERRIDE_CONNECTIVE =
  /\b(overrides?|overriding|supersed(?:e|es|ed|ing)|takes?\s+precedence|precedence\s+over|wins?\s+over|trumps?|has\s+authority\s+over|authoritative\s+over|takes?\s+priority|outrank(?:s|ed)?|beats?\b)\b|>/i;

/**
 * Validate a PRECEDENCE against its source. Both sides must be grounded and named, the relationship
 * span must be grounded, and the SOURCE must carry explicit override language, so a precedence is never
 * inferred from adjacency, recency, or confidence. This is the FALSE_PRECEDENCE = 0 guarantee.
 */
export function validatePrecedenceInput(input: PrecedenceInput, itemText: string): PrecedenceValidation {
  if (!input.source?.id) return { ok: false, code: "precedence_source_missing", message: "A precedence must name its source." };
  const winners = input.winner_evidence.filter((s) => s.trim().length > 0);
  if (winners.length === 0) return { ok: false, code: "precedence_no_winner", message: "A precedence must name the winning side." };
  const losers = input.loser_evidence.filter((s) => s.trim().length > 0);
  if (losers.length === 0) return { ok: false, code: "precedence_no_loser", message: "A precedence must name the losing side." };
  const ungroundedW = winners.find((s) => !itemText.includes(s));
  if (ungroundedW) return { ok: false, code: "precedence_winner_not_grounded", message: `The winner is not present in the source: ${JSON.stringify(ungroundedW.slice(0, 60))}` };
  const ungroundedL = losers.find((s) => !itemText.includes(s));
  if (ungroundedL) return { ok: false, code: "precedence_loser_not_grounded", message: `The loser is not present in the source: ${JSON.stringify(ungroundedL.slice(0, 60))}` };
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (winners.some((w) => losers.some((l) => norm(w) === norm(l)))) {
    return { ok: false, code: "precedence_winner_equals_loser", message: "A precedence's winner and loser must differ." };
  }
  const rel = input.relationship_evidence.filter((s) => s.trim().length > 0 && itemText.includes(s));
  if (rel.length === 0) return { ok: false, code: "precedence_no_relationship", message: "A precedence must quote the relationship span from the source." };
  // The relationship must be EXPRESSED, not inferred. Require explicit override language in the source.
  if (!OVERRIDE_CONNECTIVE.test(itemText)) {
    return { ok: false, code: "precedence_no_override_language", message: "The source expresses no override relationship (no overrides/supersedes/takes precedence/...)." };
  }
  return { ok: true, value: { ...input, winner_evidence: winners, loser_evidence: losers, relationship_evidence: rel } };
}

export function stampProposedPrecedence(value: PrecedenceInput, opts: { now: string }): PrecedenceAtom {
  const fingerprint = precedenceFingerprint(value);
  return {
    id: fingerprint, kind: "precedence",
    winner_evidence: value.winner_evidence, winner_normalized: value.winner_evidence.length > 0 ? null : value.winner_normalized,
    loser_evidence: value.loser_evidence, loser_normalized: value.loser_evidence.length > 0 ? null : value.loser_normalized,
    relationship_evidence: value.relationship_evidence, condition_normalized: value.condition_normalized,
    source: value.source, observed_at: value.observed_at,
    authority: "inferred", status: "proposed", created_at: opts.now, approved_by: null, fingerprint,
  };
}

export function approvePrecedence(atom: PrecedenceAtom, approvedBy: string): PrecedenceAtom {
  return { ...atom, authority: "human", status: "active", approved_by: approvedBy };
}
export function rejectPrecedence(atom: PrecedenceAtom, rejectedBy: string): PrecedenceAtom {
  return { ...atom, authority: "inferred", status: "rejected", approved_by: rejectedBy };
}

/** Would this be USED by the conflict compiler? A person approved it and it is active. No weak tier. */
export function isPrecedenceActive(atom: PrecedenceAtom): boolean {
  return atom.authority === "human" && atom.status === "active";
}

const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

export function parsePrecedenceAtom(raw: unknown): PrecedenceAtom | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o["kind"] !== "precedence") return null;
  const status = o["status"];
  if (status !== "proposed" && status !== "active" && status !== "rejected") return null;
  const authority = o["authority"];
  if (authority !== "human" && authority !== "inferred") return null;
  const src = o["source"];
  if (!src || typeof src !== "object") return null;
  const s = src as Record<string, unknown>;
  if ((s["kind"] !== "memory" && s["kind"] !== "rule") || typeof s["id"] !== "string") return null;
  const winners = asStringArray(o["winner_evidence"]);
  const losers = asStringArray(o["loser_evidence"]);
  if (winners.length === 0 || losers.length === 0) return null;
  const id = typeof o["id"] === "string" ? o["id"] : null;
  const fingerprint = typeof o["fingerprint"] === "string" ? o["fingerprint"] : id;
  if (!id || !fingerprint) return null;
  return {
    id, kind: "precedence",
    winner_evidence: winners, winner_normalized: typeof o["winner_normalized"] === "string" ? o["winner_normalized"] : null,
    loser_evidence: losers, loser_normalized: typeof o["loser_normalized"] === "string" ? o["loser_normalized"] : null,
    relationship_evidence: asStringArray(o["relationship_evidence"]),
    condition_normalized: typeof o["condition_normalized"] === "string" ? o["condition_normalized"] : null,
    source: { kind: s["kind"], id: s["id"], title: typeof s["title"] === "string" ? s["title"] : "", node_path: typeof s["node_path"] === "string" ? s["node_path"] : null },
    observed_at: typeof o["observed_at"] === "string" ? o["observed_at"] : "",
    authority, status,
    created_at: typeof o["created_at"] === "string" ? o["created_at"] : "",
    approved_by: typeof o["approved_by"] === "string" ? o["approved_by"] : null,
    fingerprint,
  };
}
