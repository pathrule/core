// SPDX-License-Identifier: Apache-2.0
// Pure local semantic ranking + candidate shaping.
//
// Pure (no SQLite, no network deps) so the SQLite-backed and in-memory backends
// share it — same placement as project-map-rank / co-change-rank / briefing.
//
// Shapes scored candidates via confidence tiers, lexical-overlap marking,
// direct-id dedup, and a top-N cap. The output is the canonical
// `SemanticCandidatesPayload` shape from @pathrule/shared, so the AI client sees
// an identical `semantic_candidates` field.

import type {
  SemanticCandidateOut,
  SemanticCandidatesPayload,
  SubtreeMemoryIndexResult,
} from "@pathrule/shared/routing-types.js";

// Thresholds match the documented canonical values so the field reads the same
// across editions.
export const SEMANTIC_CONFIDENCE_HIGH_MIN = 0.78;
export const SEMANTIC_CONFIDENCE_MEDIUM_MIN = 0.5;
export const SEMANTIC_CANDIDATES_MAX = 5;
export const SEMANTIC_SCAN_TOP_K = 10;
export const SEMANTIC_QUERY_MIN_SIMILARITY = 0.45;

/** A memory scored against the query embedding, before confidence shaping. */
export interface ScoredCandidate {
  id: string;
  title: string;
  node_path: string;
  similarity: number;
}

/** Lexical surface ids the agent already saw — used to dedup / mark agreement. */
export interface LexicalIds {
  /** Direct memory ids (already shown with bodies) — dropped from candidates. */
  direct: Set<string>;
  /** Subtree + discovery title-only ids — kept with lexical_overlap=true. */
  titleOnly: Set<string>;
}

export function collectLexicalIds(input: {
  bundleMemories: Array<{ id: string }> | undefined;
  subtreeIndex: SubtreeMemoryIndexResult | undefined;
  discoveryCandidateTitles: Array<{ id: string }> | undefined;
}): LexicalIds {
  const direct = new Set<string>();
  for (const m of input.bundleMemories ?? []) {
    if (m && typeof m.id === "string") direct.add(m.id);
  }
  const titleOnly = new Set<string>();
  for (const e of input.subtreeIndex?.entries ?? []) {
    if (e && typeof e.id === "string") titleOnly.add(e.id);
  }
  for (const c of input.discoveryCandidateTitles ?? []) {
    if (c && typeof c.id === "string") titleOnly.add(c.id);
  }
  return { direct, titleOnly };
}

/** Cosine similarity of two equal-length numeric vectors. 0 for a zero vector. */
// Accepts ArrayLike so callers can pass a Float32Array view straight off a stored
// blob without copying it into a plain array first.
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (magA === 0 || magB === 0) return 0;
  const sim = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  // A non-finite element in a stored vector (corrupt/hand-edited DB row) would
  // propagate NaN/Infinity here; clamp to 0 so a bad vector never out-ranks a
  // real match or leaks NaN into the emitted similarity score.
  return Number.isFinite(sim) ? sim : 0;
}

/** Deterministic embedded-text composer shared by the on-write embed path. */
export function composeEmbeddingText(title: string, content: string): string {
  const summary = (content ?? "").replace(/\s+/g, " ").trim().slice(0, 1600);
  return `Title: ${title}\nSummary: ${summary}`;
}

/**
 * Shape scored candidates into the additive `semantic_candidates` payload:
 * similarity-descending, drop direct (already-shown) ids, mark lexical overlap
 * as high-confidence agreement, apply HIGH/MEDIUM tiers, drop low-confidence,
 * cap at MAX. Returns undefined when nothing survives (caller emits
 * `no_candidates`).
 */
export function shapeLocalSemanticCandidates(input: {
  scored: ScoredCandidate[];
  lexical: LexicalIds;
  matchedNodePath: string;
  model: string;
  limit: number;
  minSimilarity: number;
  outputMax?: number;
}): SemanticCandidatesPayload | undefined {
  const max = input.outputMax ?? SEMANTIC_CANDIDATES_MAX;
  const sorted = [...input.scored].sort((a, b) => b.similarity - a.similarity);
  const seen = new Set<string>();
  const out: SemanticCandidateOut[] = [];

  for (const cand of sorted) {
    if (out.length >= max) break;
    if (!cand || typeof cand.id !== "string") continue;
    if (seen.has(cand.id)) continue;
    if (input.lexical.direct.has(cand.id)) continue; // already shown with body

    const overlap = input.lexical.titleOnly.has(cand.id);
    // Guard against a non-finite score (NaN survives a `typeof === "number"` check
    // and would serialize as `null` in the emitted payload, and a lexical-overlap
    // candidate is force-promoted to "high" before any similarity tier check).
    const sim = Number.isFinite(cand.similarity) ? cand.similarity : 0;

    let confidence: "high" | "medium" | null = null;
    if (overlap || sim >= SEMANTIC_CONFIDENCE_HIGH_MIN) confidence = "high";
    else if (sim >= SEMANTIC_CONFIDENCE_MEDIUM_MIN) confidence = "medium";
    if (confidence === null) continue; // low-confidence: dropped by design

    seen.add(cand.id);
    out.push({
      id: cand.id,
      title: cand.title,
      node_path: cand.node_path,
      similarity: Number(sim.toFixed(4)),
      source: "semantic",
      confidence,
      ...(overlap ? { lexical_overlap: true } : {}),
      reason: overlap
        ? "lexical_and_vector_overlap"
        : confidence === "high"
          ? "high_similarity"
          : "medium_similarity",
    });
  }

  if (out.length === 0) return undefined;
  return {
    candidates: out,
    model: input.model,
    searched_scope: {
      matched_node_path: input.matchedNodePath,
      limit: input.limit,
      min_similarity: input.minSimilarity,
    },
  };
}
