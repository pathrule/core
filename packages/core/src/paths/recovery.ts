// SPDX-License-Identifier: Apache-2.0
//
// Recovery for repos that were synced by an OLDER Pathrule, back when it took a
// user's instruction file over instead of merging a region into it.
//
// Those repos carry leftovers the new writers never produce:
//   - `backup.CLAUDE.md`, `backup.AGENTS.md`, `backup..cursorrules` (the double
//     dot came from prefixing an already-dotted filename) next to the original;
//   - `.pathrule/backups/<path>` entries from the interim vault layout;
//   - a live instruction file that is entirely Pathrule's, while the user's real
//     content sits in one of the above.
//
// The contract here is deliberately conservative: this module only REPORTS. It
// never restores automatically. A user may have deliberately abandoned that old
// file, and silently reviving it would be a second surprise on top of the first.
// The desktop turns a plan into an offer; the user decides per item.
//
// Pure and dependency-free: callers supply the file listing and contents, which
// keeps this testable and usable from desktop, CLI, and MCP alike.

import { isPathruleManaged } from "./ownership.js";
import { hasRegion, isEntirelyPathrule, stripRegion } from "./region.js";
import { BACKUP_DIR } from "./workspace-files.js";

/** Instruction filenames a client dictates, which a user may own. */
const INSTRUCTION_BASENAMES = new Set([
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  "copilot-instructions.md",
]);

/** One file on disk, as the caller found it. */
export interface ScannedFile {
  /** Workspace-relative, forward slashes, no leading slash. */
  path: string;
  content: string;
}

export type LeftoverKind =
  /** `backup.<name>` (or `backup..<name>`) sitting next to the original. */
  | "stray_backup"
  /** An entry under `.pathrule/backups/`. */
  | "vault_backup";

export interface Leftover {
  kind: LeftoverKind;
  /** Where the leftover lives now. */
  path: string;
  /** The instruction file it was taken from, if that can be determined. */
  restoresTo: string | null;
  /**
   * True when the live file at `restoresTo` currently holds NO user content, so
   * restoring is purely additive. False when the user already has content there
   * and a merge decision is needed.
   */
  liveFileIsPathruleOnly: boolean;
  /** First line of the backup, to show the user what it is. */
  preview: string;
}

export interface RecoveryPlan {
  leftovers: Leftover[];
  /** Live instruction files that are entirely Pathrule's with a backup available. */
  restorable: Leftover[];
  /** Leftovers whose live file already has user content: needs a human choice. */
  needsChoice: Leftover[];
}

/** "packages/api/backup.CLAUDE.md" → "packages/api/CLAUDE.md" */
function strayBackupTarget(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "" : path.slice(0, slash + 1);
  const base = path.slice(slash + 1);

  // Numbered collisions: backup.CLAUDE.md.3
  const withoutSuffix = base.replace(/\.\d+$/, "");
  if (!withoutSuffix.startsWith("backup.")) return null;

  // `backup.` + name, or the malformed `backup.` + `.dotfile` → `backup..dotfile`
  const remainder = withoutSuffix.slice("backup.".length);
  const candidate = remainder.startsWith(".") ? remainder : remainder;
  if (!INSTRUCTION_BASENAMES.has(candidate)) return null;
  return `${dir}${candidate}`;
}

/** ".pathrule/backups/packages/api/CLAUDE.md" → "packages/api/CLAUDE.md" */
function vaultBackupTarget(path: string): string | null {
  const prefix = `${BACKUP_DIR}/`;
  if (!path.startsWith(prefix)) return null;
  const inner = path.slice(prefix.length).replace(/\.\d+$/, "");
  const base = inner.slice(inner.lastIndexOf("/") + 1);
  return INSTRUCTION_BASENAMES.has(base) ? inner : null;
}

function firstMeaningfulLine(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("<!--")) continue;
    return trimmed.slice(0, 120);
  }
  return "";
}

/**
 * Build a recovery plan from a scan of the workspace.
 *
 * Callers pass every file they are willing to consider; this picks out the
 * leftovers and works out whether each one can be restored cleanly.
 */
export function buildRecoveryPlan(files: readonly ScannedFile[]): RecoveryPlan {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const leftovers: Leftover[] = [];

  for (const file of files) {
    const strayTarget = strayBackupTarget(file.path);
    const vaultTarget = strayTarget === null ? vaultBackupTarget(file.path) : null;
    if (strayTarget === null && vaultTarget === null) continue;

    const restoresTo = strayTarget ?? vaultTarget;
    const live = restoresTo === null ? undefined : byPath.get(restoresTo);

    // No live file at all, or a live file that holds nothing of the user's.
    const liveFileIsPathruleOnly =
      live === undefined ||
      isEntirelyPathrule(live) ||
      (hasRegion(live) && stripRegion(live).trim() === "") ||
      (isPathruleManaged(live) && !hasRegion(live));

    leftovers.push({
      kind: strayTarget !== null ? "stray_backup" : "vault_backup",
      path: file.path,
      restoresTo,
      liveFileIsPathruleOnly,
      preview: firstMeaningfulLine(file.content),
    });
  }

  leftovers.sort((a, b) => a.path.localeCompare(b.path));
  return {
    leftovers,
    restorable: leftovers.filter((l) => l.liveFileIsPathruleOnly),
    needsChoice: leftovers.filter((l) => !l.liveFileIsPathruleOnly),
  };
}

/**
 * The bytes to write when restoring one leftover, or null when the caller must
 * ask the user first.
 *
 * Restoring never discards Pathrule's region: the user's recovered content goes
 * back, and the region is re-merged on the next sync. When the live file already
 * has user content, this returns null rather than guessing at a merge.
 */
export function restoredBody(leftover: Leftover, backupContent: string): string | null {
  if (!leftover.liveFileIsPathruleOnly) return null;
  const body = backupContent.replace(/\n+$/, "");
  return body === "" ? "" : `${body}\n`;
}
