// SPDX-License-Identifier: Apache-2.0
//
// Well-known Pathrule locations inside a user's workspace. Single source of
// truth so every writer (desktop, CLI, MCP server) agrees, and so a path can
// never drift between two code paths the way the backup location once did.
//
// Pure strings, no I/O, so any package can import this.

/** Machine-local Pathrule state, gitignored as a whole. */
export const PATHRULE_DIR = ".pathrule";

/**
 * Where a user's pre-existing file goes when Pathrule takes over its filename.
 *
 * The original relative path is preserved beneath this directory, e.g.
 * `packages/api/CLAUDE.md` → `.pathrule/backups/packages/api/CLAUDE.md`.
 * That keeps two same-named files in different packages from colliding, keeps a
 * dotfile's real name intact, makes restoring a straight copy back, and keeps
 * the working tree free of stray `backup.*` files.
 */
export const BACKUP_DIR = `${PATHRULE_DIR}/backups`;

/** The managed-file ownership ledger. */
export const MANAGED_FILES_LEDGER = `${PATHRULE_DIR}/managed-files.json`;

/**
 * Where a design is exported for a coding agent to read.
 *
 * A handoff used to inline the design in the prompt, which cannot carry a multi-screen
 * flow: eight screens of markup blows the context window. The agent reads this folder
 * instead (Read / Grep / Glob, and the per-screen PNG), so nothing has to be inlined and
 * only what changed is rewritten between transfers.
 *
 * Machine-local and gitignored, like everything under PATHRULE_DIR: it is derived from the
 * design store, so it must never be a thing a repo carries or a reviewer diffs.
 */
export const DESIGN_EXPORT_DIR = `${PATHRULE_DIR}/design`;

/** Workspace-relative export root for one design document. */
export function designExportRelativePath(designId: string): string {
  // Ids come from the store (nanoid-style), but this composes a filesystem path, so it is
  // sanitised rather than trusted. Separators go first, then any run of dots collapses to
  // one so no `..` survives inside the segment, then leading dots and dashes are dropped so
  // the result cannot read as a dotfile or a flag.
  const safe = designId
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+/, "");
  return `${DESIGN_EXPORT_DIR}/${safe || "design"}`;
}

/** Workspace-relative backup location for a workspace-relative source path. */
export function backupRelativePath(relativePath: string): string {
  const clean = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${BACKUP_DIR}/${clean}`;
}
