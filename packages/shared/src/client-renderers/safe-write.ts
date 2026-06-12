// Safe-write policy for Pathrule-managed files. Routes per-path between
// three regimes:
//
//   1. "overwrite"            — Pathrule fully owns the filename; just write.
//                               Used for filenames Pathrule invented (e.g.
//                               .claude/rules/pathrule-protocol.md,
//                               .cursor/rules/pathrule-protocol.mdc).
//
//   2. "backup-on-first-write" — User-canonical filename that pre-dates
//                               Pathrule (e.g. .cursorrules, AGENTS.md,
//                               .windsurfrules). On the first run, if the
//                               existing on-disk content lacks Pathrule's
//                               marker, rename it to backup.<name> (with
//                               numeric suffix on collision) before writing
//                               Pathrule's body. Subsequent runs: in-place
//                               overwrite (Pathrule already owns).
//
//   3. "merge-<filename>"     — Structured config (JSON / TOML). Pathrule
//                               owns specific entries inside the file but
//                               user content elsewhere must survive. The
//                               renderer's emitted body is the FRESH-WRITE
//                               body; the merger transforms it against the
//                               existing file.
//
// Node-only — uses fs/promises. Imported by disk-writer.ts.

import { access, readFile, rename } from "node:fs/promises";
import { constants as FS_CONSTS } from "node:fs";
import { dirname, join, basename } from "node:path";

import {
  ensureClaudeSettingsHook,
  ensureCodexConfigToml,
  ensureCodexHooks,
  ensureCursorHooks,
} from "../pathrule-protocol.js";

export type SafeWritePolicy =
  | { kind: "overwrite" }
  | { kind: "backup-on-first-write"; markerSubstring: string }
  | { kind: "merge"; merger: (existing: string | null) => { body: string; changed: boolean } };

// Marker substring search inside files Pathrule owns end-to-end. If the
// substring shows up, we know this is a Pathrule-managed file (regardless of
// content drift) — so no backup is needed.
const PATHRULE_MARKDOWN_MARKER = "<!-- Pathrule managed";
const PATHRULE_CLAUDE_MARKER = "<!-- managed by Pathrule";
const PATHRULE_TOML_MARKER = "# >>> Pathrule managed";

export const SAFE_WRITE_POLICIES: Record<string, SafeWritePolicy> = {
  // ─── Cursor ───────────────────────────────────────────────────────────
  ".cursor/rules/pathrule-protocol.mdc": { kind: "overwrite" },
  ".cursorrules": {
    kind: "backup-on-first-write",
    markerSubstring: PATHRULE_MARKDOWN_MARKER,
  },
  ".cursor/hooks.json": { kind: "merge", merger: ensureCursorHooks },

  // ─── Claude (parity reference — most paths flow through their own
  // bespoke pipeline in project-claude-md.ts; entries here are for any
  // call site that goes through writeMultiClientFiles) ──────────────────
  ".claude/rules/pathrule-protocol.md": { kind: "overwrite" },
  ".claude/settings.json": { kind: "merge", merger: ensureClaudeSettingsHook },
  "CLAUDE.md": {
    kind: "backup-on-first-write",
    markerSubstring: PATHRULE_CLAUDE_MARKER,
  },

  // ─── Codex ─────────────────────────────────────────────────────────────
  "AGENTS.md": {
    kind: "backup-on-first-write",
    markerSubstring: PATHRULE_MARKDOWN_MARKER,
  },
  ".codex/hooks.json": { kind: "merge", merger: ensureCodexHooks },
  ".codex/config.toml": { kind: "merge", merger: ensureCodexConfigToml },

  // ─── Windsurf ─────────────────────────────────────────────────────────
  ".windsurf/rules/pathrule-protocol.md": { kind: "overwrite" },
  ".windsurfrules": {
    kind: "backup-on-first-write",
    markerSubstring: PATHRULE_MARKDOWN_MARKER,
  },
};

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, FS_CONSTS.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function uniqueBackupPath(desired: string): Promise<string> {
  if (!(await exists(desired))) return desired;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${desired}.${i}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Could not find a free backup name near ${desired}`);
}

export interface PrepareResult {
  /** Final body to write. Null = nothing to do (already up-to-date or skipped). */
  finalBody: string | null;
  /** Path of the backup we wrote, if any. */
  backupPath: string | null;
}

/**
 * Decide what (if anything) to write for `relativePath` and back up the
 * user's existing content when needed. Caller is expected to pass the
 * renderer's desired body and the workspace root; the actual disk write
 * still happens in disk-writer.ts via atomicWrite.
 *
 * Returns `finalBody = null` only when the merger reports no change AND the
 * existing on-disk body matches — this lets the caller short-circuit to a
 * skip without redundant atomic-rename churn.
 */
/**
 * Policy for paths not in the exact-match table. Nested knowledge files reuse
 * user-canonical filenames (lib/AGENTS.md, lib/CLAUDE.md), so any unknown
 * path whose basename is a known agent-instruction filename gets
 * backup-on-first-write — a pre-existing user file at that path is backed
 * up, never silently overwritten. Everything else stays "overwrite"
 * (Pathrule-invented filenames).
 */
function fallbackPolicy(relativePath: string): SafeWritePolicy {
  const base = basename(relativePath);
  if (base === "AGENTS.md" || base === "CLAUDE.md") {
    return { kind: "backup-on-first-write", markerSubstring: PATHRULE_MARKDOWN_MARKER };
  }
  return { kind: "overwrite" };
}

export async function prepareSafeWrite(opts: {
  workspaceRoot: string;
  relativePath: string;
  renderedBody: string;
  existingBody: string | null;
}): Promise<PrepareResult> {
  const policy = SAFE_WRITE_POLICIES[opts.relativePath] ?? fallbackPolicy(opts.relativePath);
  const abs = join(opts.workspaceRoot, opts.relativePath);

  switch (policy.kind) {
    case "overwrite": {
      if (opts.existingBody === opts.renderedBody) return { finalBody: null, backupPath: null };
      return { finalBody: opts.renderedBody, backupPath: null };
    }

    case "backup-on-first-write": {
      const isFirstTime =
        opts.existingBody !== null &&
        !opts.existingBody.includes(policy.markerSubstring) &&
        opts.existingBody !== opts.renderedBody;

      let backupPath: string | null = null;
      if (isFirstTime) {
        const backupAbs = await uniqueBackupPath(join(dirname(abs), `backup.${basename(abs)}`));
        await rename(abs, backupAbs);
        backupPath = backupAbs;
      }

      if (opts.existingBody === opts.renderedBody) {
        return { finalBody: null, backupPath: null };
      }
      return { finalBody: opts.renderedBody, backupPath };
    }

    case "merge": {
      const { body: merged, changed } = policy.merger(opts.existingBody);
      if (!changed && opts.existingBody === merged) {
        return { finalBody: null, backupPath: null };
      }
      return { finalBody: merged, backupPath: null };
    }
  }
}

/** Backup helper exposed for the onboarding `backupAndConsolidate` flow that
 *  needs a deterministic suffixed path without writing. */
export { uniqueBackupPath };
