// SPDX-License-Identifier: Apache-2.0
/**
 * Verification evidence: answering "did the required verification pass in this session?"
 *
 * Deliberately SEPARATE from `bash-exploration.ts`'s `BashCategory`. That field answers
 * "what kind of work was this call", is tuned for exploration ROI, and its `combine` is
 * conservative on purpose: one unrecognised segment makes the whole line `unknown`,
 * because "I understood half of this" is not evidence about the whole. Correct for
 * telemetry, far too coarse for evidence. Measured on this repo's real commands, 9 of 15
 * came back `unknown` and `node scripts/with-sqlite-native.mjs vitest run`, the actual
 * `test` script of four packages, came back `execution`.
 *
 * Nothing here changes `cat`. It adds one more field.
 *
 * Three rules the whole module is built around:
 *
 *  1. FAIL CLOSED. A command whose pass/fail cannot be attributed to the verification
 *     produces NO signal. A missing signal costs a re-run; a wrong one is a false PASS,
 *     and a false PASS is the only outcome that makes this channel worse than nothing.
 *
 *  2. NO RAW COMMAND, NO ABSOLUTE PATHS. The fingerprint carries a runner name, a script
 *     name and a workspace-relative or package-name scope. An absolute path, a `~` path
 *     or a glob as the scope means the scope cannot be named, and an unnamed scope would
 *     collide with a different package's run, so those produce no signal either.
 *
 *  3. READABLE, NOT HASHED. A hash would be smaller and just as private, but the last
 *     six rounds of this work were only possible because the telemetry could be read by
 *     eye. `vitest@dir:packages/shared` is inspectable; a hash is a promise.
 *
 * WHAT A FINGERPRINT CLAIMS, AND WHAT IT DOES NOT.
 *
 * It claims IDENTITY: this invocation is stably the same logical command as that one,
 * and its exit code belongs to it. It does NOT claim the command is a verification.
 * Nothing here can know that, and the attempt to know it was a measured bug.
 *
 * Measured on this repo's 149 real package.json scripts: the name `build` appears ten
 * times, and it is a pure `tsup` in @pathrule/admin while in @pathrule/web it is four
 * `scripts/check-*.mjs` runs plus a bundle-budget check. Same name, opposite meaning, so
 * a name-keyword list cannot be right in principle. And `build-storybook`, whose
 * greenness a project rule makes a merge gate, is `storybook build --disable-telemetry`:
 * no verification signal in the name OR the body, so no repo-local deterministic signal
 * can promote it either.
 *
 * The judgement therefore belongs where it already lives: a CHECK atom is enforceable
 * only after an explicit human approval, and that approval is the assertion that the
 * named command is the verification. Re-deriving it here rejected two commands a person
 * had correctly named (`pnpm --filter @pathrule/app build-storybook`,
 * `pnpm web:prod-security`) and prevented the CHECK from existing at all.
 *
 * Removing that gate does not open a false-PASS path. A required fingerprint is matched
 * exactly, so a different script's identity cannot satisfy it, and the exit-code rules
 * below are untouched.
 */

import { splitCommandSegments, tokenizeCommandSegment } from "./bash-exploration.js";

export interface VerificationSignal {
  /**
   * Stable, path-free identity of the logical verification.
   * Shape: `<runner>[:<target>][@<scope_kind>:<scope>][#narrowed]`
   */
  fingerprint: string;
  /** The tool that does the verifying: "vitest", "pnpm", "pytest", … */
  runner: string;
  /** Named script the command ran, when it ran one: "test", "test:runtime", "db:test". */
  target: string | null;
  /** What the verification covers, as written and normalised. */
  scope: string | null;
  /** How to read `scope`. `null` only when there is no scope at all. */
  scope_kind: "package" | "dir" | "recursive" | null;
  /**
   * True when the run was narrowed to named files. A narrowed run is real evidence about
   * those files and NO evidence about the suite, so it must never satisfy a suite-level
   * requirement. That is why it is in the fingerprint rather than beside it.
   */
  narrowed: boolean;
}

/** Test runners recognised as verification on their own. */
const RUNNERS: Record<string, true> = {
  vitest: true, jest: true, pytest: true, mocha: true, ava: true, playwright: true,
  cypress: true, tap: true, karma: true, nyc: true,
};

/** Programs that commonly wrap a runner (`node scripts/x.mjs vitest run`). */
const RUNNER_WRAPPERS: Record<string, true> = { node: true, tsx: true, bun: true, deno: true };

const PACKAGE_MANAGERS: Record<string, true> = { npm: true, pnpm: true, yarn: true, npx: true, pnpx: true };

/** Leading tokens that wrap the real command rather than being it. Mirrors bash-exploration. */
const WRAPPERS: Record<string, true> = {
  sudo: true, command: true, time: true, nohup: true, exec: true, env: true, nice: true,
};

/**
 * Flags that put a runner into watch mode, so it never produces a one-shot verdict.
 * Detectable from the invocation itself, which is all this function sees. A script NAMED
 * `test:watch` is not detectable here: its body lives in package.json, which the hook
 * does not read. That hole is unchanged by this file and is recorded as such.
 */
const WATCH_FLAGS = new Set(["--watch", "-w", "--watchAll", "--watch-all"]);

/** Subcommands that mean "run the named script that follows". */
const RUN_SUBCOMMANDS: Record<string, true> = { run: true, exec: true, dlx: true };

/** Flags that take a separate value, so the value is not the subcommand. */
const VALUE_FLAGS: Record<string, true> = { "--filter": true, "-F": true, "--dir": true, "-C": true, "--workspace": true };

const MAX_COMMAND_CHARS = 4000;
const MAX_SCOPE_CHARS = 120;

/** A runner's own subcommands, which are not file arguments. */
const RUNNER_SUBCOMMANDS: Record<string, true> = { run: true, watch: true, related: true, bench: true };

/**
 * Runners that WATCH unless told to run once. Without this, `pnpm vitest` (watch) and
 * `pnpm vitest run` (one shot) produced the SAME fingerprint, so a watch session could
 * satisfy a requirement naming the one-shot suite. That is a false PASS, which is the
 * one outcome this channel must never produce.
 */
const WATCH_BY_DEFAULT: Record<string, true> = { vitest: true };

/** Does the invocation of a watch-by-default runner ask for a single run? */
function asksForSingleRun(rest: string[]): boolean {
  return rest.some((t) => t === "run" || t === "--run");
}

function basename(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash === -1 ? token : token.slice(slash + 1);
}

/** A script name is a valid identity as long as it is a plausible script token. */
function isScriptToken(name: string): boolean {
  return Boolean(name) && name.length <= 80 && !name.startsWith("-");
}

/**
 * Normalise a scope token, or return null when it cannot be named safely.
 *
 * Rejects absolute paths, `~` paths and globs. This is the same posture the hook's path
 * telemetry already took after it was caught turning `/Users/<name>/x` into
 * `Users/<name>/x` by stripping the leading slash: a path that cannot be expressed
 * workspace-relatively is dropped, never mangled into something that looks relative.
 */
function normaliseScope(raw: string | undefined): string | null {
  if (!raw) return null;
  const token = raw.trim().replace(/^["']|["']$/g, "");
  if (!token || token.length > MAX_SCOPE_CHARS) return null;
  if (token.startsWith("/") || token.startsWith("~")) return null;
  if (token.includes("://")) return null;
  if (/[*?[\]{}]/.test(token)) return null;
  if (token === "." || token === "..") return null;
  const trimmed = token.replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** A scope token that names a workspace package rather than a directory. */
function looksLikePackageName(token: string): boolean {
  if (token.startsWith("@")) return true;
  return !token.includes("/");
}

interface Segment {
  tokens: string[];
  family: string;
  rest: string[];
}

function peel(segment: string): Segment | null {
  const tokens = tokenizeCommandSegment(segment).filter((t) => !/^\d?>{1,2}/.test(t) && t !== "&>");
  let head = 0;
  while (head < tokens.length) {
    const t = tokens[head]!;
    if (WRAPPERS[basename(t)] === true || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) head += 1;
    else break;
  }
  if (head >= tokens.length) return null;
  return { tokens, family: basename(tokens[head]!), rest: tokens.slice(head + 1) };
}

/** Bare (non-flag) tokens, with the values of value-taking flags removed. */
function bareTokens(rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i]!;
    if (VALUE_FLAGS[t] === true) {
      i += 1; // its value is not a positional
      continue;
    }
    if (t.startsWith("-")) continue;
    out.push(t);
  }
  return out;
}

/** Read `--filter X` / `-F X` / `--filter=X`, and the recursive flag. */
function readScopeFlags(rest: string[]): { scope: string | null; kind: "package" | "dir" | "recursive" | null; poisoned: boolean } {
  let recursive = false;
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i]!;
    if (t === "-r" || t === "--recursive") {
      recursive = true;
      continue;
    }
    const inline = /^(--filter|--workspace|--dir)=(.*)$/.exec(t);
    const raw = inline ? inline[2] : VALUE_FLAGS[t] === true ? rest[i + 1] : undefined;
    if (raw === undefined) continue;
    const scope = normaliseScope(raw);
    // A filter was given but cannot be named: the scope is real and unrepresentable, so
    // a scopeless fingerprint would silently collide with a different package's run.
    if (scope === null) return { scope: null, kind: null, poisoned: true };
    return { scope, kind: looksLikePackageName(scope) ? "package" : "dir", poisoned: false };
  }
  return recursive ? { scope: null, kind: "recursive", poisoned: false } : { scope: null, kind: null, poisoned: false };
}

interface RunnerHit {
  runner: string;
  target: string | null;
  narrowed: boolean;
}

/** Positional file arguments after a runner mean the run was narrowed. */
function isNarrowed(after: string[]): boolean {
  return after.some((t) => !RUNNER_SUBCOMMANDS[t]);
}

function classifySegmentRunner(seg: Segment): RunnerHit | null {
  const { family, rest } = seg;

  if (RUNNERS[family] === true) {
    if (WATCH_BY_DEFAULT[family] === true && !asksForSingleRun(rest)) return null;
    return { runner: family, target: null, narrowed: isNarrowed(bareTokens(rest)) };
  }

  if (PACKAGE_MANAGERS[family] === true) {
    const bare = bareTokens(rest);
    const sub = bare[0];
    if (!sub) return null;

    if (RUNNERS[sub] === true) {
      if (WATCH_BY_DEFAULT[sub] === true && !asksForSingleRun(rest)) return null;
      return { runner: sub, target: null, narrowed: isNarrowed(bare.slice(1)) };
    }
    if (RUN_SUBCOMMANDS[sub] === true) {
      const named = bare[1];
      if (!named) return null;
      if (RUNNERS[named] === true) {
        if (WATCH_BY_DEFAULT[named] === true && !asksForSingleRun(rest)) return null;
        return { runner: named, target: null, narrowed: isNarrowed(bare.slice(2)) };
      }
      if (!isScriptToken(named)) return null;
      // A script's body is not read here, so extra positionals after it are opaque and
      // cannot be judged as narrowing.
      return { runner: family, target: named, narrowed: false };
    }
    if (isScriptToken(sub)) {
      return { runner: family, target: sub, narrowed: false };
    }
    return null;
  }

  // `node scripts/with-sqlite-native.mjs vitest run` is the real `test` script of four
  // packages here. The wrapper is opaque; the runner it hands off to is not.
  if (RUNNER_WRAPPERS[family] === true) {
    const bare = bareTokens(rest);
    const index = bare.findIndex((t) => RUNNERS[basename(t)] === true);
    if (index === -1) return null;
    const wrapped = basename(bare[index]!);
    if (WATCH_BY_DEFAULT[wrapped] === true && !asksForSingleRun(rest)) return null;
    return { runner: wrapped, target: null, narrowed: isNarrowed(bare.slice(index + 1)) };
  }

  return null;
}

function buildFingerprint(hit: RunnerHit, scope: string | null, kind: VerificationSignal["scope_kind"]): string {
  const head = hit.target ? `${hit.runner}:${hit.target}` : hit.runner;
  const scopePart = kind === "recursive" ? "@recursive" : kind && scope ? `@${kind}:${scope}` : "";
  return `${head}${scopePart}${hit.narrowed ? "#narrowed" : ""}`;
}

/**
 * Identify the verification a bash command performs, or null.
 *
 * Returns null, on purpose, for:
 *  - anything with a pipe. `pnpm test 2>&1 | tail -20` exits with tail's status, so a
 *    FAILING suite reports success. That is a false PASS, and no classifier can repair
 *    it: the information is gone before the exit code is taken.
 *  - more than one verification in one line. `ok` is a single value and attributing it
 *    to two runs needs the separator semantics this deliberately does not model.
 *  - a scope that exists but cannot be named safely (absolute path, `~`, glob).
 */
export function classifyVerificationCommand(command: unknown): VerificationSignal | null {
  if (typeof command !== "string" || command.trim() === "") return null;
  const bounded = command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command;

  // Pipes break exit-code attribution. `||` too, and it contains `|`.
  if (bounded.includes("|")) return null;

  // A watch-mode run never terminates, so its exit code says nothing about the code
  // under test.
  if (bounded.split(/\s+/).some((t) => WATCH_FLAGS.has(t))) return null;

  // A watch-mode run does not terminate, so its exit code says nothing about the code
  // under test. Measured hole this closes: `pnpm test:watch` is `vitest` with no `run`,
  // and the old gate accepted it because the NAME contained "test".
  const rawTokens = bounded.split(/\s+/);
  if (rawTokens.some((t) => WATCH_FLAGS.has(t))) return null;

  const segments = splitCommandSegments(bounded);
  if (segments.length === 0) return null;

  let dirScope: string | null = null;
  let dirScopePoisoned = false;
  let hit: RunnerHit | null = null;
  let hitSegment: Segment | null = null;
  let hitCount = 0;

  for (const raw of segments) {
    const seg = peel(raw);
    if (!seg) continue;

    if (seg.family === "cd" || seg.family === "pushd") {
      const target = bareTokens(seg.rest)[0];
      const scope = normaliseScope(target);
      if (scope === null) dirScopePoisoned = true;
      else dirScope = scope;
      continue;
    }

    const found = classifySegmentRunner(seg);
    if (found) {
      hitCount += 1;
      hit = found;
      hitSegment = seg;
    }
  }

  if (!hit || !hitSegment || hitCount !== 1) return null;

  const flagScope = readScopeFlags(hitSegment.rest);
  if (flagScope.poisoned) return null;

  let scope = flagScope.scope;
  let kind = flagScope.kind;
  if (kind === null && dirScope !== null) {
    scope = dirScope;
    kind = "dir";
  }
  // A `cd` whose target could not be named leaves the verification's scope unknown.
  if (kind === null && dirScopePoisoned) return null;

  return {
    fingerprint: buildFingerprint(hit, scope, kind),
    runner: hit.runner,
    target: hit.target,
    scope,
    scope_kind: kind,
    narrowed: hit.narrowed,
  };
}

// ─── Session-level evidence ──────────────────────────────────────────────────

/** One logical verification as the session observed it. */
export interface VerificationOutcome {
  fingerprint: string;
  runs: number;
  /** Last observed result. A later failure supersedes an earlier pass. */
  passed: boolean;
  last_at: string | null;
}

/** The subset of an outcome row this reads. Keeps the module independent of the full shape. */
export interface VerificationRow {
  /** Verification fingerprint, written by the hook for bash calls. */
  v?: unknown;
  /** 1 = success, 0 = failure. */
  ok?: unknown;
  /** ISO timestamp. */
  at?: unknown;
}

/**
 * Fold a session's rows into one outcome per fingerprint.
 *
 * LAST result wins rather than "any pass". A suite that passed and then failed after a
 * further edit has not passed, and "any pass in the session" is exactly the indicator
 * that cannot tell those two apart.
 */
export function collectSessionVerifications(rows: readonly VerificationRow[]): VerificationOutcome[] {
  const byFingerprint = new Map<string, VerificationOutcome>();
  for (const row of rows) {
    const fingerprint = typeof row.v === "string" && row.v.length > 0 ? row.v : null;
    if (!fingerprint) continue;
    const at = typeof row.at === "string" ? row.at : null;
    const passed = row.ok === 1 || row.ok === true;
    const existing = byFingerprint.get(fingerprint);
    if (!existing) {
      byFingerprint.set(fingerprint, { fingerprint, runs: 1, passed, last_at: at });
      continue;
    }
    existing.runs += 1;
    existing.passed = passed;
    existing.last_at = at ?? existing.last_at;
  }
  return [...byFingerprint.values()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

/**
 * Did the verification a required command names pass in this session?
 *
 * The required command is fingerprinted the same way the observed one was, so the
 * comparison is between two canonical forms and never between two command strings.
 * An unrecognisable requirement answers `false`: a requirement that cannot be
 * fingerprinted can never be satisfied, and saying otherwise would satisfy it by
 * accident.
 */
export function requiredVerificationPassed(
  requiredCommand: string,
  rows: readonly VerificationRow[],
): { known: boolean; passed: boolean; fingerprint: string | null } {
  const required = classifyVerificationCommand(requiredCommand);
  if (!required) return { known: false, passed: false, fingerprint: null };
  const match = collectSessionVerifications(rows).find((o) => o.fingerprint === required.fingerprint);
  return { known: true, passed: match?.passed === true, fingerprint: required.fingerprint };
}
