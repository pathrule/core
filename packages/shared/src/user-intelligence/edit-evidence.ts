// SPDX-License-Identifier: Apache-2.0
/**
 * Learning from what a person does to the agent's code, rather than from what they say about it.
 *
 * The strongest everyday signal about how someone wants code written is the edit they make AFTER the
 * agent finished: the comments they delete, the logging they strip, the file they throw away, the change
 * they undo. Acceptance on its own says little (people accept out of fatigue), but a person spending
 * their own effort to change the agent's output has disagreed with it, and disagreement is information.
 *
 * Two moments, both deterministic, no model anywhere:
 *
 *  1. CAPTURE, at the end of an agent turn. For every file the agent changed, keep the lines the agent
 *     ADDED that are still in the file when the turn ends, each reduced to a short hash plus a coarse
 *     kind (comment, logging, error handling, dependency). No source text is stored: the hash is enough
 *     to ask later "is this line still there?", and a line of someone's code never leaves this file.
 *  2. OBSERVE, before the next turn in the same workspace starts (so the agent has not touched anything
 *     yet). Re-read those files and count which of the agent's lines the person removed.
 *
 * What an observation may conclude is deliberately narrow. A wholesale undo is recorded as a REVERT and
 * nothing else, because a person reverting a change is not telling us which part they disliked. A kind is
 * only counted as removed when the person removed most of THAT kind while keeping most of the rest; that
 * is the difference between "deletes the agent's comments" and "rewrote the block, comments included".
 */
import { createHash } from "node:crypto";

/** Coarse classes of agent-added line whose removal says something about the person. */
export type LineKind = "comment" | "logging" | "error_handling" | "dependency";

/** What a single observation can show. Each trait is counted per episode, never per line. */
export type EditTrait =
  | "comments"
  | "logging"
  | "error_handling"
  | "dependencies"
  | "new_files"
  | "trims"
  | "revert";

export const EDIT_TRAITS: readonly EditTrait[] = [
  "comments", "logging", "error_handling", "dependencies", "new_files", "trims", "revert",
];

export interface CapturedLine {
  /** Short hash of the normalised line. Never the line itself. */
  h: string;
  k: LineKind | null;
}

export interface CapturedFile {
  /** Workspace-relative, forward slashes. */
  path: string;
  /** The agent created this file during the turn. */
  created: boolean;
  /** Hash of the whole file as the agent left it, so an untouched file costs one comparison. */
  fileHash: string;
  /**
   * Hash of the file's normalised line multiset. Equal after a formatter pass, different once anyone
   * changed what the code says, which is how the oversight map tells "reformatted" from "reviewed".
   * Absent on episodes captured before it existed.
   */
  shape?: string;
  lines: CapturedLine[];
}

/** Per-file caps. A generated lockfile or a thousand-line scaffold says nothing a sample would not. */
export const MAX_CAPTURED_LINES_PER_FILE = 400;
export const MAX_CAPTURED_FILES_PER_TURN = 20;
export const MAX_OBSERVED_FILE_BYTES = 512 * 1024;

/**
 * Normalise a line so a formatter pass does not read as the person deleting it.
 *
 * Whitespace collapses, quote style is unified, and trailing `;` / `,` are dropped: those are exactly
 * the edits Prettier, Black and friends make on save. Anything left after that is a real change.
 */
export function normalizeLine(line: string): string {
  return line
    .trim()
    .replace(/\s+/g, " ")
    .replace(/['`]/g, "\"")
    .replace(/[;,]+$/, "")
    .trim();
}

/** A line too short to mean anything on its own: braces, brackets, `else`, `end`. */
export function isTrivialLine(normalized: string): boolean {
  return normalized.length < 4 || /^[{}()[\];,.<>/\\|:-]+$/.test(normalized);
}

export function hashLine(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const PROSE_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;

/**
 * Classify one agent-added line. Coarse on purpose: a wrong `null` only loses a signal, a wrong kind
 * would teach the person something they never did.
 */
export function classifyLine(normalized: string, filePath: string): LineKind | null {
  const base = filePath.split("/").pop() ?? filePath;
  if (base === "package.json") {
    // A dependency entry: `"name": "^1.2.3"` (versions, tags, workspace and git specifiers alike).
    if (/^"(@[\w.-]+\/)?[\w.-]+"\s*:\s*"(\^|~|>=|<=|\d|workspace:|npm:|git|github:|latest|next)/.test(normalized)) return "dependency";
    return null;
  }
  if (/^requirements[\w.-]*\.txt$/i.test(base)) {
    return /^[A-Za-z0-9_.-]+(\[[^\]]*\])?\s*(==|>=|<=|~=|>|<|$)/.test(normalized) && !normalized.startsWith("#") ? "dependency" : null;
  }
  if (PROSE_FILE.test(base)) return null;
  if (
    /^(\/\/|\/\*|\*\s|\*\/|<!--)/.test(normalized) ||
    normalized === "*" ||
    (/^#(\s|$)/.test(normalized) && !/^#\s*(include|define|if|endif|pragma|import)\b/.test(normalized))
  ) {
    return "comment";
  }
  if (/\b(console\.(log|debug|info|trace)|debugPrint|NSLog|println!?|fmt\.Print(ln|f)?|logger\.(debug|trace|info)|log\.(debug|trace))\s*\(/.test(normalized) ||
      /^print\s*\(/.test(normalized)) {
    return "logging";
  }
  if (/^(try\b|\}?\s*catch\b|catch\s*[({]|except\b|\}?\s*finally\b|finally\s*[:{]|rescue\b|do \{$)/.test(normalized)) {
    return "error_handling";
  }
  return null;
}

/**
 * The `+` lines of a tool result's `diffPatch`, without the marker.
 *
 * The stored format (adapters/tool-diff.ts) has already stripped file headers, so every line starts with
 * exactly one of ' ', '+', '-' or is a bare '@@'. A line starting "+++" is therefore an added line whose
 * content starts "++" (`++i`), not a header, and must be kept. Engines that build no diff (OpenCode,
 * Grok, Kimi, Antigravity today) contribute no added lines; only their created files are observable.
 */
export function addedLinesFromPatch(patch: string | undefined): string[] {
  if (!patch) return [];
  const out: string[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+")) out.push(raw.slice(1));
  }
  return out;
}

/**
 * Capture one file at the end of the agent's turn.
 *
 * Only agent-added lines that are STILL in the file are kept, since the agent may have added and then
 * removed a line itself within the same turn, and that is not the person's doing.
 */
export function captureFile(input: {
  path: string;
  created: boolean;
  content: string;
  addedLines: readonly string[];
}): CapturedFile | null {
  if (input.content.length > MAX_OBSERVED_FILE_BYTES) return null;
  const present = lineMultiset(input.content);
  const lines: CapturedLine[] = [];
  const seen = new Map<string, number>();
  for (const raw of input.addedLines) {
    const normalized = normalizeLine(raw);
    if (isTrivialLine(normalized)) continue;
    const h = hashLine(normalized);
    // Respect multiplicity: two identical added lines need two surviving copies.
    const used = seen.get(h) ?? 0;
    if ((present.get(h) ?? 0) <= used) continue;
    seen.set(h, used + 1);
    lines.push({ h, k: classifyLine(normalized, input.path) });
    if (lines.length >= MAX_CAPTURED_LINES_PER_FILE) break;
  }
  if (lines.length === 0 && !input.created) return null;
  return { path: input.path, created: input.created, fileHash: hashContent(input.content), shape: shapeOf(present), lines };
}

/** Hash multiset of a file's non-trivial lines. */
export function lineMultiset(content: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const raw of content.split("\n")) {
    const normalized = normalizeLine(raw);
    if (isTrivialLine(normalized)) continue;
    const h = hashLine(normalized);
    out.set(h, (out.get(h) ?? 0) + 1);
  }
  return out;
}

/** One hash for a line multiset: order and formatting do not change it, content does. */
export function shapeOf(multiset: ReadonlyMap<string, number>): string {
  return hashLine([...multiset].map(([h, n]) => `${h}:${n}`).sort().join(","));
}

export interface KindCount {
  present: number;
  removed: number;
}

export interface FileObservation {
  path: string;
  created: boolean;
  /** The person deleted the whole file. */
  deleted: boolean;
  /** The file is byte-identical to how the agent left it. */
  untouched: boolean;
  /** Someone changed what the file says (not only its formatting), or deleted it. */
  edited: boolean;
  total: number;
  removed: number;
  byKind: Record<LineKind, KindCount>;
}

function emptyKinds(): Record<LineKind, KindCount> {
  return {
    comment: { present: 0, removed: 0 },
    logging: { present: 0, removed: 0 },
    error_handling: { present: 0, removed: 0 },
    dependency: { present: 0, removed: 0 },
  };
}

/** Compare one captured file with what is on disk now. `content` null means the file is gone. */
export function observeFile(captured: CapturedFile, content: string | null): FileObservation {
  const byKind = emptyKinds();
  for (const line of captured.lines) if (line.k) byKind[line.k].present += 1;
  const base = { path: captured.path, created: captured.created, total: captured.lines.length, byKind };

  if (content === null) {
    for (const k of Object.keys(byKind) as LineKind[]) byKind[k].removed = byKind[k].present;
    return { ...base, deleted: true, untouched: false, edited: true, removed: captured.lines.length };
  }
  if (hashContent(content) === captured.fileHash) {
    return { ...base, deleted: false, untouched: true, edited: false, removed: 0 };
  }
  const remaining = lineMultiset(content);
  const edited = captured.shape === undefined || shapeOf(remaining) !== captured.shape;
  let removed = 0;
  for (const line of captured.lines) {
    const left = remaining.get(line.h) ?? 0;
    if (left > 0) {
      remaining.set(line.h, left - 1);
      continue;
    }
    removed += 1;
    if (line.k) byKind[line.k].removed += 1;
  }
  return { ...base, deleted: false, untouched: false, edited, removed };
}

/** One trait's outcome in one episode: it had the chance to happen, and it did or did not. */
export interface TraitOutcome {
  trait: EditTrait;
  occurred: boolean;
  /** A short, human-readable account for the inspect surface. Paths stay local with it. */
  detail: string;
}

/** Share of a kind the person removed, and the share of everything else, across an episode. */
function kindShare(files: readonly FileObservation[], kind: LineKind): { present: number; removed: number; otherTotal: number; otherRemoved: number } {
  let present = 0, removed = 0, otherTotal = 0, otherRemoved = 0;
  for (const f of files) {
    if (f.deleted && f.created) continue; // a thrown-away new file is its own trait
    present += f.byKind[kind].present;
    removed += f.byKind[kind].removed;
    let kindTotal = 0, kindRemoved = 0;
    for (const k of Object.keys(f.byKind) as LineKind[]) { kindTotal += f.byKind[k].present; kindRemoved += f.byKind[k].removed; }
    otherTotal += f.total - kindTotal;
    otherRemoved += f.removed - kindRemoved;
  }
  return { present, removed, otherTotal, otherRemoved };
}

const TRAIT_KIND: Partial<Record<EditTrait, LineKind>> = {
  comments: "comment",
  logging: "logging",
  error_handling: "error_handling",
  dependencies: "dependency",
};

/**
 * What one observed episode says, trait by trait. A trait appears only when the episode gave it an
 * OPPORTUNITY; an untouched file is evidence too (the person kept what the agent wrote).
 */
export function traitOutcomes(files: readonly FileObservation[]): TraitOutcome[] {
  const out: TraitOutcome[] = [];
  const total = files.reduce((n, f) => n + f.total, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  // A revert explains everything else away: record it alone.
  if (total >= 3) {
    const reverted = removed / total >= 0.9;
    out.push({ trait: "revert", occurred: reverted, detail: `${removed} of ${total} added lines removed` });
    if (reverted) return out;
  }

  for (const [trait, kind] of Object.entries(TRAIT_KIND) as Array<[EditTrait, LineKind]>) {
    const s = kindShare(files, kind);
    if (s.present === 0) continue;
    // Deliberate removal of THIS kind: most of it gone, most of the rest kept.
    const selective = s.removed / s.present >= 0.5 && (s.otherTotal === 0 || s.otherRemoved / s.otherTotal < 0.5);
    out.push({ trait, occurred: selective, detail: `${s.removed} of ${s.present} ${kind.replace("_", " ")} lines removed` });
  }

  const created = files.filter((f) => f.created);
  if (created.length > 0) {
    const deleted = created.filter((f) => f.deleted).length;
    out.push({ trait: "new_files", occurred: deleted > 0, detail: `${deleted} of ${created.length} new files deleted` });
  }

  // Cutting the agent's code down, apart from comments and logging (those are their own traits).
  let plainTotal = 0, plainRemoved = 0;
  for (const f of files) {
    if (f.deleted && f.created) continue;
    const special = f.byKind.comment.present + f.byKind.logging.present;
    const specialRemoved = f.byKind.comment.removed + f.byKind.logging.removed;
    plainTotal += f.total - special;
    plainRemoved += f.removed - specialRemoved;
  }
  if (plainTotal >= 8) {
    const trimmed = plainRemoved >= 4 && plainRemoved / plainTotal >= 0.3;
    out.push({ trait: "trims", occurred: trimmed, detail: `${plainRemoved} of ${plainTotal} code lines removed` });
  }
  return out;
}
