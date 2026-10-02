// SPDX-License-Identifier: Apache-2.0
/**
 * The ingestion trigger: analyse ONE named knowledge item for corrective knowledge.
 *
 * Deliberately explicit and bounded. Not a repository scanner, not a watcher, not something that
 * runs on every keystroke: a local model call costs seconds and a proposal costs a human a
 * review, so the product asks for this rather than deciding on the user's behalf. A batch
 * variant exists for a handful of items and is capped for the same reason.
 *
 * It reads REAL product knowledge through the backend. Nothing here knows about the benchmark.
 */
import type { RemedyParseMode } from "../knowledge/remedy-extraction.js";
import type { RemedyAtom } from "../knowledge/remedy.js";

import type { LocalIntelligenceClient } from "./client.js";
import { extractRemedy, type RemedyExtractionOutcome } from "./remedy-pipeline.js";

/** The slice of the backend this needs, so the trigger is testable without a database. */
export interface AnalyzableKnowledge {
  readMemory(id: string): Promise<{
    id: string;
    workspaceId: string;
    title: string;
    content: string;
    createdAt?: string;
    updatedAt?: string;
  } | null>;
  proposeRemedyAtom(workspaceId: string, atom: RemedyAtom): Promise<RemedyAtom>;
  listRemedyAtomsForSubject(subjectType: "memory" | "rule", subjectId: string): Promise<RemedyAtom[]>;
}

export type AnalyzeOutcome =
  | { status: "proposed"; atom: RemedyAtom; recovered: number; ms: number; parseMode: RemedyParseMode }
  | { status: "already_decided"; atom: RemedyAtom }
  | { status: "no_remedy"; reason: string; ms: number; parseMode: RemedyParseMode }
  | { status: "not_found"; memoryId: string }
  | { status: "failed"; kind: string; message: string };

/** How many items one explicit request may analyse. A bound, not a preference. */
export const MAX_BATCH = 20;

/**
 * Analyse one memory.
 *
 * Short-circuits when this memory already has a DECIDED atom, so re-analysing something the user
 * approved or rejected costs no inference and cannot resurrect a rejected proposal. A still
 * pending proposal is left alone by the same reasoning, and the store's fingerprint uniqueness
 * is the backstop if two callers race.
 */
export async function analyzeMemoryForRemedy(
  backend: AnalyzableKnowledge,
  client: LocalIntelligenceClient,
  memoryId: string,
  now: string,
): Promise<AnalyzeOutcome> {
  const memory = await backend.readMemory(memoryId);
  if (!memory) return { status: "not_found", memoryId };

  const existing = await backend.listRemedyAtomsForSubject("memory", memoryId);
  const decided = existing.find((a) => a.status !== "proposed");
  if (decided) return { status: "already_decided", atom: decided };
  const pending = existing.find((a) => a.status === "proposed");
  if (pending) return { status: "already_decided", atom: pending };

  const outcome: RemedyExtractionOutcome = await extractRemedy(
    client,
    {
      kind: "memory",
      id: memory.id,
      title: memory.title,
      body: memory.content,
      nodePath: null,
      // Provenance is when the knowledge was recorded, not when this analysis ran.
      observedAt: memory.updatedAt ?? memory.createdAt ?? now,
    },
    now,
  );

  if (outcome.status === "failed") {
    return { status: "failed", kind: outcome.error.kind, message: outcome.error.message };
  }
  if (outcome.status === "no_remedy") {
    return { status: "no_remedy", reason: outcome.reason, ms: outcome.ms, parseMode: outcome.parseMode };
  }
  const stored = await backend.proposeRemedyAtom(memory.workspaceId, outcome.atom);
  return { status: "proposed", atom: stored, recovered: outcome.recovered, ms: outcome.ms, parseMode: outcome.parseMode };
}

export interface BatchResult {
  analyzed: number;
  proposed: RemedyAtom[];
  skipped: number;
  noRemedy: number;
  /** How each model response was parsed. Salvage must stay a rare emergency path, not the parser. */
  parseModes: Record<RemedyParseMode, number>;
  /** Failures are surfaced, never counted as "nothing found". */
  failures: Array<{ memoryId: string; kind: string; message: string }>;
}

/**
 * Analyse a bounded list of memories.
 *
 * Sequential on purpose: a local model serves one request at a time, and a parallel fan-out
 * would only queue inside the server while making a partial failure harder to attribute.
 */
export async function analyzeMemoriesForRemedy(
  backend: AnalyzableKnowledge,
  client: LocalIntelligenceClient,
  memoryIds: string[],
  now: string,
): Promise<BatchResult> {
  const result: BatchResult = {
    analyzed: 0, proposed: [], skipped: 0, noRemedy: 0,
    parseModes: { json: 0, salvage: 0, failed: 0 }, failures: [],
  };
  for (const id of memoryIds.slice(0, MAX_BATCH)) {
    const out = await analyzeMemoryForRemedy(backend, client, id, now);
    result.analyzed += 1;
    if (out.status === "proposed" || out.status === "no_remedy") result.parseModes[out.parseMode] += 1;
    switch (out.status) {
      case "proposed": result.proposed.push(out.atom); break;
      case "already_decided": result.skipped += 1; break;
      case "no_remedy": result.noRemedy += 1; break;
      case "not_found": result.failures.push({ memoryId: id, kind: "not_found", message: "memory not found" }); break;
      case "failed": result.failures.push({ memoryId: id, kind: out.kind, message: out.message }); break;
    }
  }
  return result;
}
