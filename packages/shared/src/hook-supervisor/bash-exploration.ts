// Bash exploration classifier, TELEMETRY ONLY.
//
// WHY THIS EXISTS. Measured 2026-09-03 over 54 real sessions / 5.289 tool events:
// 92,0% of every tool call an agent makes here is `bash`, and NONE of those carry a
// `file_path`. Only 4,5% of all tool events carry one at all, and 31 of 54 sessions
// carry zero, so `file_tool_count` (and the route-follow detection built on it)
// reported "this session explored nothing" for sessions that ran dozens of
// `cat`/`grep`/`sed -n` calls. An indicator that cannot separate "did not explore"
// from "explored entirely through bash" produces confident wrong reports.
//
// HARD CONTRACT. This module NEVER changes agent behaviour. It produces telemetry,
// nothing else. No caller may use its output to allow, deny, reorder or gate a tool
// call. It is pure: no I/O, no clock, no network, no shell AST dependency.
//
// PARSING IS BEST-EFFORT ON PURPOSE. A correct POSIX shell parser is neither cheap
// enough for the hot path nor worth its failure modes here. Every ambiguity resolves
// to `unknown` rather than to a guess: an over-confident classification would feed a
// wrong number into research conclusions, while `unknown` only under-reports.
//
// The hook (`pathrule-hook.js`) ships standalone to ~/.pathrule/bin and cannot import
// from this package, so it carries an INLINE MIRROR of this logic. The mirror is
// pinned to this module behaviourally by `pathrule-hook-bash-telemetry.test.ts`,
// which drives the real hook script against the same fixtures, the same discipline
// `pathrule-hook-friction-parity.test.ts` applies to the failure-code bank.

/** Coarse intent of a bash command. `unknown` is a first-class, preferred answer. */
export type BashCategory = "exploration" | "mutation" | "execution" | "test" | "unknown";

export interface BashClassification {
  /** Conservative combination across all segments (see `combine`). */
  category: BashCategory;
  /** Command family of the first recognised segment (`rg`, `git`, `cat`, …). */
  family: string | null;
  /** Operand paths the command READ, exactly as written. Deduped, capped. */
  pathsObserved: string[];
  /** Operand paths the command WROTE, exactly as written. Deduped, capped. */
  pathsModified: string[];
  /** True when at least one segment could not be recognised. */
  hasUnknownSegment: boolean;
}

/** Upper bound on the command text we look at. Longer input is truncated, not parsed. */
export const MAX_COMMAND_CHARS = 4000;
/** Upper bound on paths reported per command, so one `cat a b c …` cannot balloon a line. */
export const MAX_PATHS = 20;

/** Read-only discovery commands. Their operands are recorded as `pathsObserved`. */
const EXPLORATION: Record<string, true> = {
  cat: true, bat: true, head: true, tail: true, nl: true, less: true, more: true,
  grep: true, egrep: true, fgrep: true, rg: true, ag: true, ack: true,
  find: true, fd: true, ls: true, tree: true, wc: true, file: true, stat: true,
  diff: true, comm: true, cmp: true, du: true, readlink: true, realpath: true,
  od: true, xxd: true, strings: true, jq: true, yq: true, column: true,
};

/** State-changing commands. Their operands are recorded as `pathsModified`. */
const MUTATION: Record<string, true> = {
  rm: true, mv: true, cp: true, mkdir: true, rmdir: true, touch: true, ln: true,
  chmod: true, chown: true, truncate: true, dd: true, tee: true, patch: true,
  install: true, shred: true,
};

/** Test runners. Narrow on purpose, a broad list would swallow ordinary execution. */
const TEST: Record<string, true> = {
  vitest: true, jest: true, pytest: true, mocha: true, ava: true, playwright: true,
  cypress: true, tap: true,
};

/** Programs that run something. Operands are NOT recorded (they are inputs, not reads). */
const EXECUTION: Record<string, true> = {
  node: true, tsx: true, deno: true, bun: true, python: true, python3: true,
  ruby: true, php: true, java: true, go: true, cargo: true, make: true, cmake: true,
  docker: true, tsc: true, eslint: true, prettier: true, curl: true, wget: true,
  echo: true, printf: true, sleep: true, kill: true, open: true, code: true,
};

/** `git <sub>` classification. Anything absent stays `unknown`. */
const GIT_SUBCOMMANDS: Record<string, BashCategory> = {
  log: "exploration", show: "exploration", diff: "exploration", grep: "exploration",
  status: "exploration", blame: "exploration", "ls-files": "exploration",
  "rev-parse": "exploration", "show-ref": "exploration", describe: "exploration",
  shortlog: "exploration", "cat-file": "exploration", "diff-tree": "exploration",
  add: "mutation", commit: "mutation", checkout: "mutation", switch: "mutation",
  reset: "mutation", restore: "mutation", rm: "mutation", mv: "mutation",
  clean: "mutation", stash: "mutation", merge: "mutation", rebase: "mutation",
  apply: "mutation", push: "mutation", pull: "mutation", fetch: "mutation",
  cherry: "mutation", "cherry-pick": "mutation", tag: "mutation", init: "mutation",
  clone: "mutation", branch: "mutation", worktree: "mutation",
};

/** Package managers whose meaning lives entirely in the subcommand. */
const PACKAGE_MANAGERS: Record<string, true> = { npm: true, pnpm: true, yarn: true, npx: true, pnpx: true };

/** Families whose FIRST non-flag operand is a search pattern, not a path. */
const PATTERN_FIRST: Record<string, true> = {
  grep: true, egrep: true, fgrep: true, rg: true, ag: true, ack: true, sed: true, awk: true,
};

/** Leading tokens that wrap the real command rather than being it. */
const WRAPPERS: Record<string, true> = {
  sudo: true, command: true, time: true, nohup: true, exec: true, env: true, nice: true,
};

/**
 * Path-ish operands we refuse to report even when a command names them. `/` and `.`
 * are the reason `ls /` must never count as following a route: a token that names
 * the whole tree carries no evidence about WHERE the agent looked.
 */
const TOO_BROAD = new Set(["/", ".", "..", "~", "~/", "*", "**", "./", "../", "-"]);

function basename(command: string): string {
  const slash = command.lastIndexOf("/");
  return slash === -1 ? command : command.slice(slash + 1);
}

/**
 * Whitespace tokenizer with minimal quote handling. It does NOT implement shell
 * quoting rules, it only keeps a quoted run together so `rg "a b" src` yields three
 * tokens. Anything it gets wrong degrades to an unrecognised token, never to a
 * confident misclassification.
 */
export function tokenizeCommandSegment(segment: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (buf) out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Split a command line into segments on `&&`, `||`, `;`, `|` and newlines.
 *
 * Quote-unaware by design: a separator inside a quoted string produces one extra
 * segment that will not be recognised, which pushes the whole command toward
 * `unknown`. That is the safe direction.
 */
export function splitCommandSegments(command: string): string[] {
  return command
    .split(/\n|&&|\|\||[;|]/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True when a token can be reported as a path operand. */
function looksLikePath(token: string): boolean {
  if (!token || token.length > 300) return false;
  if (token.startsWith("-")) return false;
  if (token.includes("://")) return false;
  if (TOO_BROAD.has(token)) return false;
  // A glob is a SHAPE, not a location. `find . -name '*.ts'` names no path the agent
  // actually looked at, and `packages/*/src` cannot be matched against a route without
  // expanding it. Both would manufacture route-follow evidence, so neither qualifies.
  if (/[*?[\]{}]/.test(token)) return false;
  // A path either names a directory (has a separator) or a file (has an extension).
  if (token.includes("/")) return true;
  return /\.[A-Za-z0-9]{1,8}$/.test(token);
}

/** Strip a trailing separator so `/packages/app/` and `/packages/app` compare equal. */
function trimTrailingSlash(token: string): string {
  return token.length > 1 && token.endsWith("/") ? token.slice(0, -1) : token;
}

interface SegmentResult {
  category: BashCategory;
  family: string | null;
  observed: string[];
  modified: string[];
}

function collectOperands(tokens: string[], family: string): string[] {
  const skipPattern = PATTERN_FIRST[family] === true;
  let patternSkipped = !skipPattern;
  const out: string[] = [];
  for (const token of tokens) {
    if (token.startsWith("-")) continue;
    if (!patternSkipped) {
      // The first non-flag operand of grep/rg/sed/awk is the expression, not a path.
      patternSkipped = true;
      continue;
    }
    if (looksLikePath(token)) out.push(trimTrailingSlash(token));
  }
  return out;
}

function classifySegment(segment: string): SegmentResult {
  const tokens = tokenizeCommandSegment(segment);
  const empty: SegmentResult = { category: "unknown", family: null, observed: [], modified: [] };
  if (tokens.length === 0) return empty;

  // A redirection anywhere in the segment means the segment writes. The target is the
  // token after it (or the remainder of a `>file` token).
  const modified: string[] = [];
  let redirects = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t === ">" || t === ">>" || t === "1>" || t === "2>" || t === "&>") {
      redirects = true;
      const target = tokens[i + 1];
      if (target && looksLikePath(target)) modified.push(trimTrailingSlash(target));
      continue;
    }
    if (/^>{1,2}[^>]/.test(t)) {
      redirects = true;
      const target = t.replace(/^>{1,2}/, "");
      if (looksLikePath(target)) modified.push(trimTrailingSlash(target));
    }
  }

  // Peel wrappers and leading `FOO=bar` assignments off the front.
  let head = 0;
  while (head < tokens.length) {
    const t = tokens[head]!;
    if (WRAPPERS[basename(t)] === true || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) head += 1;
    else break;
  }
  if (head >= tokens.length) return { ...empty, modified };

  const family = basename(tokens[head]!);
  const rest = tokens.slice(head + 1);

  const finish = (category: BashCategory): SegmentResult => {
    if (redirects && category !== "unknown") {
      // A read command that redirects still wrote something. Writing dominates.
      return { category: "mutation", family, observed: [], modified };
    }
    if (category === "exploration") {
      return { category, family, observed: collectOperands(rest, family), modified };
    }
    if (category === "mutation") {
      return { category, family, observed: [], modified: [...modified, ...collectOperands(rest, family)] };
    }
    // execution / test / unknown: operands are inputs to a program, not evidence of a
    // read. Recording them would manufacture route-follow false positives.
    return { category, family, observed: [], modified };
  };

  if (family === "git") {
    const sub = rest.find((t) => !t.startsWith("-"));
    const mapped = sub ? GIT_SUBCOMMANDS[sub] : undefined;
    if (!mapped) return { category: redirects ? "mutation" : "unknown", family, observed: [], modified };
    if (mapped === "exploration") {
      const after = rest.slice(rest.indexOf(sub!) + 1);
      return redirects
        ? { category: "mutation", family, observed: [], modified }
        : { category: "exploration", family, observed: collectOperands(after, "git"), modified };
    }
    return { category: "mutation", family, observed: [], modified };
  }

  if (family === "sed") {
    // `sed -i` edits in place; every other form is a read.
    const inPlace = rest.some((t) => t === "-i" || /^-i[^\s]*$/.test(t) || t === "--in-place");
    return finish(inPlace ? "mutation" : "exploration");
  }

  if (family === "awk") {
    // awk can print or can write via redirection inside the program text. Not worth
    // parsing; the program text is opaque, so this stays unknown.
    return { category: redirects ? "mutation" : "unknown", family, observed: [], modified };
  }

  if (PACKAGE_MANAGERS[family] === true) {
    const sub = rest.find((t) => !t.startsWith("-"));
    if (!sub) return { category: "unknown", family, observed: [], modified };
    if (sub === "test" || TEST[sub] === true) return finish("test");
    if (sub === "install" || sub === "add" || sub === "remove" || sub === "uninstall" || sub === "ci") {
      return finish("mutation");
    }
    if (sub === "run" || sub === "exec" || sub === "dlx") {
      const script = rest[rest.indexOf(sub) + 1];
      if (script && (script === "test" || /(^|[:-])test([:-]|$)/.test(script))) return finish("test");
      return finish("execution");
    }
    return { category: "unknown", family, observed: [], modified };
  }

  if (TEST[family] === true) return finish("test");
  if (EXPLORATION[family] === true) return finish("exploration");
  if (MUTATION[family] === true) return finish("mutation");
  if (EXECUTION[family] === true) return finish("execution");
  return { category: redirects ? "mutation" : "unknown", family, observed: [], modified };
}

function dedupeCapped(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}

/**
 * Combine segment categories conservatively.
 *
 * `mutation` wins outright, a command line that changes anything is not exploration,
 * whatever else it did. After that an unrecognised segment forces `unknown`, because
 * "I understood half of this" is not evidence about the whole.
 */
function combine(results: SegmentResult[]): BashCategory {
  if (results.length === 0) return "unknown";
  if (results.some((r) => r.category === "mutation")) return "mutation";
  if (results.some((r) => r.category === "unknown")) return "unknown";
  if (results.some((r) => r.category === "test")) return "test";
  if (results.some((r) => r.category === "execution")) return "execution";
  return "exploration";
}

/**
 * Classify one bash command line for telemetry.
 *
 * Never throws, never blocks, and never returns a category it could not justify.
 */
export function classifyBashCommand(command: unknown): BashClassification {
  if (typeof command !== "string" || command.trim() === "") {
    return { category: "unknown", family: null, pathsObserved: [], pathsModified: [], hasUnknownSegment: true };
  }
  const bounded = command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command;
  const segments = splitCommandSegments(bounded);
  const results = segments.map(classifySegment);

  // Paths are reported per segment, so a recognised `cat` inside an otherwise
  // unrecognised line still contributes its evidence. Only the CATEGORY is combined.
  const observed = dedupeCapped(results.flatMap((r) => r.observed));
  const modified = dedupeCapped(results.flatMap((r) => r.modified));
  const family = results.find((r) => r.family)?.family ?? null;

  return {
    category: combine(results),
    family,
    pathsObserved: observed,
    pathsModified: modified,
    hasUnknownSegment: results.some((r) => r.category === "unknown"),
  };
}

/**
 * Does an observed path count as following a routed path?
 *
 * Both arguments are workspace-relative and leading-slashed (`/packages/app`).
 *
 * EXACT or DESCENDANT only. Ancestors deliberately do NOT count: `ls /` observes the
 * ancestor of every route, and counting it would turn the route-accuracy metric into
 * a measure of how often the agent ran `ls`. False positives here are worse than
 * false negatives, because a route metric that inflates itself cannot be used to
 * decide whether routing works at all.
 */
export function observedPathFollowsRoute(observed: string, routed: string): boolean {
  if (!observed || !routed) return false;
  if (observed === "/" || routed === "/") return false;
  const o = trimTrailingSlash(observed);
  const r = trimTrailingSlash(routed);
  if (!o.startsWith("/") || !r.startsWith("/")) return false;
  return o === r || o.startsWith(`${r}/`);
}
