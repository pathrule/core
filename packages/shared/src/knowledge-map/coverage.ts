// Knowledge gaps, the pure rule. A gap is change that knowledge does
// not anchor: a directory scope that keeps changing while nothing references it (uncovered),
// or that kept changing after the newest knowledge about it (stale). Item counts are not a
// signal (correction 1), and change means commits only: uncommitted work waiting for a
// release is not churn. Paths, not words, so the rule is the same for every language.

import { stableHash } from "../versioning.js";
import { ancestorDirectories, normalizeAnchorPath, pathDepth } from "./anchors.js";

export interface GitCommitActivity {
  /** Unix seconds. */
  committedAt: number;
  /** Workspace-relative, no leading slash. */
  paths: string[];
}

export interface CoverageAnchor {
  /** File or directory, no leading slash. */
  path: string;
  /** Unix seconds of the knowledge that anchors it. */
  updatedAt: number;
  source: "path_ref" | "node" | "claim";
}

export interface KnowledgeGap {
  /** Session ledger key for in-flow delivery: "gap_" + stableHash("gap:" + scope). */
  ref: string;
  /** Directory, depth <= 4, no leading slash. */
  scope: string;
  kind: "uncovered" | "stale";
  files: number;
  commits: number;
  anchoredShare: number;
  commitsAfterKnowledge: number;
  newestKnowledgeAt: number | null;
  lastChangedAt: number;
  /** Up to 12 changed files, most-changed first; paths only, never content. */
  topPaths: string[];
  severity: "attention" | "risk";
}

export const COVERAGE_WINDOW_DAYS = 60;
export const GAP_SCOPE_MAX_DEPTH = 4;
export const GAP_MIN_FILES = 8;
export const GAP_MIN_COMMITS = 3;
export const UNCOVERED_MAX_SHARE = 0.3;
export const STALE_MIN_COMMITS_AFTER = 5;
export const STALE_MIN_DAYS = 7;
export const RISK_AFTER_DAYS = 14;
export const RISK_RECENT_DAYS = 7;
export const ANCHOR_MIN_DEPTH = 3;
export const MAX_GAPS = 20;

const DAY = 86_400;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|swift|py|sql|rs|go|kt|java|rb|css|scss)$/;
// Directory names that hold generated output, vendored code or test data, not authored source.
const SKIPPED_SEGMENTS = new Set([
  "node_modules", "dist", "build", "out", "coverage", ".next", ".turbo", ".vite", ".cache",
  "DerivedData", "Pods", "__snapshots__", "__fixtures__", "fixtures", "results",
]);
// Test directories by the common conventions, including Xcode-style "<Target>Tests/".
const TEST_FILE = /(^|\/)(test|tests|__tests__|[^/]*Tests?)\/|\.(test|spec|stories)\.[a-z]+$/;
/**
 * A commit counts toward a scope only when the scope is part of what the commit is about: a
 * third of its source files, or three of them. Barrels and registries (an index.ts touched by
 * every feature commit) are then not "change" in their own directory.
 */
export const COMMIT_SCOPE_MIN_SHARE = 1 / 3;
export const COMMIT_SCOPE_MIN_FILES = 3;

export function isCoverageSource(path: string): boolean {
  const normalized = normalizeAnchorPath(path);
  return SOURCE_FILE.test(normalized) && !TEST_FILE.test(normalized) && !normalized.split("/").some((s) => SKIPPED_SEGMENTS.has(s));
}

/** The scope a changed file counts under: its directory, truncated to depth 4. */
export function coverageScope(path: string): string {
  const segments = normalizeAnchorPath(path).split("/").filter(Boolean);
  return segments.slice(0, -1).slice(0, GAP_SCOPE_MAX_DEPTH).join("/");
}

export function gapRef(scope: string): string {
  return `gap_${stableHash(`gap:${scope}`)}`;
}

/** Is `path` (or a directory above it) the same as or under `scope`? */
export function withinScope(path: string, scope: string): boolean {
  const p = normalizeAnchorPath(path);
  const s = normalizeAnchorPath(scope);
  return p === s || p.startsWith(`${s}/`);
}

/** The newest anchor time for a file, or null when nothing anchors it. */
function anchoredAt(file: string, byPath: Map<string, number>, byNode: Map<string, number>): number | null {
  let newest: number | null = null;
  const take = (at: number | undefined): void => {
    if (at !== undefined && (newest === null || at > newest)) newest = at;
  };
  take(byPath.get(file));
  const ancestors = ancestorDirectories(file);
  for (const dir of ancestors) if (pathDepth(dir) >= ANCHOR_MIN_DEPTH) take(byPath.get(dir));
  // A node anchors its own directory and the one below it, never a whole subtree.
  const [dir, parent] = ancestors;
  for (const node of [dir, parent]) if (node) take(byNode.get(node));
  return newest;
}

export function computeCoverageGaps(input: {
  commits: readonly GitCommitActivity[];
  anchors: readonly CoverageAnchor[];
  suppressedScopes: readonly string[];
  /** Unix seconds. */
  now: number;
}): KnowledgeGap[] {
  const since = input.now - COVERAGE_WINDOW_DAYS * DAY;
  const byPath = new Map<string, number>();
  const byNode = new Map<string, number>();
  for (const anchor of input.anchors) {
    const path = normalizeAnchorPath(anchor.path);
    if (!path) continue;
    // Any node below the root counts: knowledge filed on /supabase/migrations is about that
    // directory. The root never does (the empty path above), and anchoredAt keeps every node
    // to its own directory and the one below, so a shallow node cannot cover a subtree.
    const target = anchor.source === "node" ? byNode : byPath;
    target.set(path, Math.max(target.get(path) ?? -Infinity, anchor.updatedAt));
  }
  const suppressed = input.suppressedScopes.map(normalizeAnchorPath).filter(Boolean);

  const scopes = new Map<string, { commits: Map<number, number>; files: Map<string, number> }>();
  input.commits.forEach((commit, index) => {
    if (commit.committedAt < since) return;
    const byScope = new Map<string, string[]>();
    let sources = 0;
    for (const raw of new Set(commit.paths.map(normalizeAnchorPath))) {
      if (!isCoverageSource(raw)) continue;
      sources++;
      const scope = coverageScope(raw);
      if (!scope) continue;
      const list = byScope.get(scope);
      if (list) list.push(raw);
      else byScope.set(scope, [raw]);
    }
    for (const [scope, files] of byScope) {
      if (files.length < COMMIT_SCOPE_MIN_FILES && files.length / sources < COMMIT_SCOPE_MIN_SHARE) continue;
      const entry = scopes.get(scope) ?? { commits: new Map<number, number>(), files: new Map<string, number>() };
      entry.commits.set(index, commit.committedAt);
      for (const file of files) entry.files.set(file, (entry.files.get(file) ?? 0) + 1);
      scopes.set(scope, entry);
    }
  });

  const gaps: KnowledgeGap[] = [];
  for (const [scope, { commits, files }] of scopes) {
    if (files.size < GAP_MIN_FILES || commits.size < GAP_MIN_COMMITS) continue;
    if (suppressed.some((s) => withinScope(scope, s))) continue;
    let anchored = 0;
    let newest: number | null = null;
    for (const file of files.keys()) {
      const at = anchoredAt(file, byPath, byNode);
      if (at === null) continue;
      anchored++;
      if (newest === null || at > newest) newest = at;
    }
    const times = [...commits.values()].sort((a, b) => a - b);
    const lastChangedAt = times[times.length - 1]!;
    const anchoredShare = anchored / files.size;
    const after = newest === null ? times : times.filter((t) => t > newest!);
    let kind: KnowledgeGap["kind"] | null = null;
    if (anchoredShare < UNCOVERED_MAX_SHARE) kind = "uncovered";
    else if (newest !== null && after.length >= STALE_MIN_COMMITS_AFTER && lastChangedAt - newest >= STALE_MIN_DAYS * DAY) kind = "stale";
    if (!kind) continue;
    const firstRelevant = kind === "stale" ? after[0]! : times[0]!;
    const severity: KnowledgeGap["severity"] =
      input.now - firstRelevant >= RISK_AFTER_DAYS * DAY && input.now - lastChangedAt <= RISK_RECENT_DAYS * DAY ? "risk" : "attention";
    gaps.push({
      ref: gapRef(scope),
      scope,
      kind,
      files: files.size,
      commits: commits.size,
      anchoredShare: Math.round(anchoredShare * 100) / 100,
      commitsAfterKnowledge: after.length,
      newestKnowledgeAt: newest,
      lastChangedAt,
      topPaths: [...files.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 12).map(([file]) => file),
      severity,
    });
  }
  return gaps.sort((x, y) => y.commits - x.commits || (x.scope < y.scope ? -1 : 1)).slice(0, MAX_GAPS);
}
