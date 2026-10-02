// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded deterministic span recovery for REMEDY action evidence.
 *
 * FROZEN 2026-09-07 from an external corpus, before the frozen REMEDY eval was run with it, and
 * moved here unchanged so PRODUCTION and the frozen benchmark run the SAME code. The benchmark
 * re-exports this module rather than keeping a copy: a second implementation is a second thing
 * to drift, and the whole value of the frozen eval is that it verifies what actually ships.
 *
 * This does NOT change what `grounded` means. A recovered span is accepted only because the
 * source contains it BYTE FOR BYTE, and it then goes through the ordinary validator like any
 * other extracted span. There is no similarity, no edit distance, no embedding, no second model
 * call, and no rewriting. The only thing this layer does is ask a narrower question after exact
 * grounding has already failed:
 *
 *   is there a stretch of the SOURCE that the model's proposal contains?
 *
 * ── the evidence the thresholds come from ────────────────────────────────────
 * The base extractor was run over 78 real workspace items excluded from the frozen eval by
 * content and by source id. It produced 121 action spans: 105 byte-present, 16 not. The
 * coverage of those 16 (longest source-present substring / proposal length) is BIMODAL with an
 * EMPTY BAND:
 *
 *      0-40%   4
 *     40-70%   5
 *     70-90%   1
 *     90-95%   0     <- nothing lands here
 *    95-100%   6
 *
 * So 0.95 is not a tuned number; it sits inside a gap the data left. Above it the model copied
 * a real stretch of source and added or dropped a couple of edge characters. Below it the model
 * COMPOSED something: it joined two separate root causes, or dropped every backtick, or wrote a
 * summary. Recovering from the second group would pick one of several competing fragments and
 * call the choice evidence, which is the failure this layer exists to avoid.
 *
 * Every other restriction below is there because a specific case in that corpus needed it.
 *
 * ── how the edge trim is bounded ────────────────────────────────────────────
 * The coverage floor gates the SUBSTRING path. The EDGE TRIM path is bounded instead by
 * `MAX_EDGE_TRIM_CHARS`, an absolute count, because a ratio is the wrong instrument here: it
 * punishes short spans, and the unit tests caught a ratio refusing a legitimate 74-character
 * case that needed only 4 characters removed. See that constant for the distribution it comes
 * from.
 */

/** Characters a model puts around a span it is serialising, and nothing else. */
const EDGE_NOISE_CHARS = new Set([" ", "\t", "\n", '"', "'", "`", ",", ".", "\u2026"]);

/**
 * Edge trims of `s`, in order of INCREASING removal, bounded by `MAX_EDGE_TRIM_CHARS`.
 *
 * Least-trimming is an invariant, not a preference: the first trim that lands on the source
 * wins, so the least destructive valid transformation is always the one taken. Enumerating by
 * total removed and stopping at the cap gives both properties in one loop.
 *
 * A single blanket strip was wrong and the tests caught it: on `Banned. Use \`x()\`.", ` it ate
 * the closing backtick and the full stop, which are part of the source.
 */
function edgeTrims(s: string): { text: string; left: number; right: number; total: number }[] {
  const noise = (c: string) => EDGE_NOISE_CHARS.has(c);
  let maxLeft = 0;
  while (maxLeft < s.length && noise(s[maxLeft]!)) maxLeft += 1;
  let maxRight = 0;
  while (maxRight < s.length - maxLeft && noise(s[s.length - 1 - maxRight]!)) maxRight += 1;
  const out: { text: string; left: number; right: number; total: number }[] = [];
  for (let total = 1; total <= Math.min(MAX_EDGE_TRIM_CHARS, maxLeft + maxRight); total += 1) {
    for (let left = Math.max(0, total - maxRight); left <= Math.min(total, maxLeft); left += 1) {
      const right = total - left;
      out.push({ text: s.slice(left, s.length - right), left, right, total });
    }
  }
  return out;
}

/**
 * Below this length a "recovered" span is a phrase fragment rather than evidence. The shortest
 * SAFE recovery in the external corpus was 26 characters, so 24 admits every observed safe case
 * with a small margin and nothing shorter.
 */
export const MIN_RECOVERED_CHARS = 24;

/**
 * The coverage floor, from the empty 90-95% band described above.
 */
export const MIN_COVERAGE = 0.95;

/**
 * The absolute cap on how many characters an EDGE TRIM may remove, total across both sides.
 *
 * FROZEN from the external corpus before the frozen REMEDY eval was run with it. 104 real
 * workspace items (frozen REMEDY eval excluded by source id AND by content) produced 141 action
 * spans: 120 byte-present, 21 not. Edge trim lands on the source for 8 of those 21, and the
 * distribution of characters removed has a hard ceiling:
 *
 *     1 char   5   #####
 *     2 chars  0
 *     3 chars  2   ##
 *     4 chars  1   #
 *     5+       0
 *
 * min 1, median 1, MAX 4, and every one of the 8 removed only serialisation noise: a stray
 * backtick, a wrapping quote, a `", ` tail, a full stop. Zero unsafe cases.
 *
 * The cap is 6: the observed maximum of 4 plus two characters of headroom, which is one extra
 * character per side for an equivalent artifact the corpus happens not to contain (a quote plus
 * a fence delimiter, say). It is NOT 4, because a cap set exactly at the observed maximum would
 * refuse the first slightly longer quote artifact for no reason. It is not larger either: past
 * 6 there is nothing in the corpus to justify, and the point of this bound is to remove the
 * mechanism's unbounded authority rather than to admit more.
 *
 * This value was chosen from the distribution above and from nothing else. The frozen eval was
 * not consulted, and it is run once after this and its tests are frozen.
 */
export const MAX_EDGE_TRIM_CHARS = 6;

/**
 * Words that carry no content on their own. A recovered span consisting only of these is
 * boilerplate, not corrective knowledge. Deliberately short: this is a guard against
 * degenerate matches, not a linguistic model.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "to", "of", "in", "on", "at", "by",
  "for", "with", "from", "as", "is", "are", "was", "were", "be", "been", "it", "its", "this",
  "that", "these", "those", "not", "no", "do", "does", "did", "can", "will", "would", "should",
]);

function hasContentToken(s: string): boolean {
  const tokens = s.toLowerCase().split(/[^a-z0-9_$.\-/]+/).filter(Boolean);
  return tokens.some((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Does `text` end mid-word inside `hay`? A span cut through an identifier is grounded and
 * useless: the external corpus produced "Never. Compositions go in `src/co", which is byte
 * present and names no path. Checked on BOTH sides, because a span that starts mid-identifier
 * has the same problem.
 */
function endsMidWord(text: string, hay: string, at: number): boolean {
  const wordChar = /[A-Za-z0-9_$]/;
  const before = at > 0 ? hay[at - 1]! : " ";
  const after = at + text.length < hay.length ? hay[at + text.length]! : " ";
  const first = text[0]!, last = text[text.length - 1]!;
  return (wordChar.test(last) && wordChar.test(after)) || (wordChar.test(first) && wordChar.test(before));
}

/** Every MAXIMAL source-present substring of `span`, longest first. Literal, no normalisation. */
function maximalPresent(span: string, hay: string, minLen: number): { text: string; occurrences: number }[] {
  const found = new Map<string, number>();
  for (let i = 0; i < span.length; i += 1) {
    let best = "";
    for (let j = i + minLen; j <= span.length; j += 1) {
      const cand = span.slice(i, j);
      if (hay.includes(cand)) best = cand; else break;
    }
    if (best && !found.has(best)) {
      let n = 0, from = 0;
      for (;;) { const k = hay.indexOf(best, from); if (k < 0) break; n += 1; from = k + 1; }
      found.set(best, n);
    }
  }
  const keys = [...found.keys()].sort((a, b) => b.length - a.length);
  return keys
    .filter((k) => !keys.some((o) => o !== k && o.length > k.length && o.includes(k)))
    .map((text) => ({ text, occurrences: found.get(text)! }));
}

export type RecoveryOutcome =
  | { recovered: true; span: string; how: "edge_trim" | "longest_substring"; coverage: number }
  | { recovered: false; why: string };

/**
 * Try to recover a source-present span from a proposal that failed exact grounding.
 *
 * Order matters. The edge trim is tried FIRST because it is the safest operation available:
 * it only removes characters the model added around a stretch it copied correctly, and it was
 * 2 of the 6 safe cases in the external corpus. The substring search is the fallback and
 * carries every restriction.
 */
export function recoverSpan(proposed: string, content: string): RecoveryOutcome {
  if (!proposed || !content) return { recovered: false, why: "empty input" };
  if (content.includes(proposed)) return { recovered: false, why: "already grounded, recovery not applicable" };

  // 1. edge trim: remove only the quotes and serialisation punctuation the model wrapped
  // around a stretch it copied correctly, taking the LEAST trimming that lands on the source.
  for (const { text: trimmed } of edgeTrims(proposed)) {
    if (trimmed.length < MIN_RECOVERED_CHARS || !content.includes(trimmed) || !hasContentToken(trimmed)) continue;
    let occurrences = 0, from = 0;
    for (;;) { const k = content.indexOf(trimmed, from); if (k < 0) break; occurrences += 1; from = k + 1; }
    if (occurrences !== 1) return { recovered: false, why: `trimmed span occurs ${occurrences} times, not unique` };
    if (endsMidWord(trimmed, content, content.indexOf(trimmed))) return { recovered: false, why: "trimmed span cuts through a word" };
    return { recovered: true, span: trimmed, how: "edge_trim", coverage: trimmed.length / proposed.length };
  }

  // 2. longest source-present substring, under every restriction the corpus demanded.
  const cands = maximalPresent(proposed, content, MIN_RECOVERED_CHARS);
  if (cands.length === 0) return { recovered: false, why: `no source-present substring of ${MIN_RECOVERED_CHARS}+ chars` };
  const top = cands[0]!;
  const coverage = top.text.length / proposed.length;
  if (coverage < MIN_COVERAGE) {
    return { recovered: false, why: `coverage ${(100 * coverage).toFixed(0)}% below ${(100 * MIN_COVERAGE).toFixed(0)}%: the model composed rather than copied` };
  }
  // A tie means two different stretches of source fit equally well, and choosing between them
  // would be a guess presented as evidence.
  if (cands.filter((c) => c.text.length === top.text.length).length > 1) {
    return { recovered: false, why: "several equally long candidates: ambiguous" };
  }
  if (top.occurrences !== 1) return { recovered: false, why: `candidate occurs ${top.occurrences} times in the item, not unique` };
  if (!hasContentToken(top.text)) return { recovered: false, why: "candidate carries no content-bearing token" };
  const at = content.indexOf(top.text);
  if (endsMidWord(top.text, content, at)) return { recovered: false, why: "candidate cuts through a word" };
  return { recovered: true, span: top.text, how: "longest_substring", coverage };
}
