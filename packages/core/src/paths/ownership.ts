// Who wrote this file? The one place that answers it.
//
// Pure (no fs), so every writer can share it: the multi-client disk writer, the
// dedicated root-CLAUDE.md path, the CLI, and any recovery flow. Keeping it in
// one module is what prevents the failure this replaced, where two code paths
// each checked for a DIFFERENT Pathrule banner and one of them therefore
// mistook Pathrule's own output for the user's file.

/**
 * Every banner Pathrule stamps into a file it owns. ALL of them must be
 * recognised at ALL call sites: when only one spelling was checked, Pathrule
 * failed to recognise its own root-protocol body at a nested path and re-backed
 * it up on every sync, which is how `packages/mobile` accumulated
 * `backup.CLAUDE.md` through `backup.CLAUDE.md.6`.
 *
 * Add a banner here the moment a renderer starts emitting it.
 */
export const PATHRULE_MANAGED_MARKERS = [
  "<!-- Pathrule managed", // client bodies + knowledge files
  "<!-- managed by Pathrule", // root protocol (claude-md-project.ts)
  "# >>> Pathrule managed", // marker-bound TOML / gitignore blocks
  "<!-- pathrule:begin", // an anchored region inside a user-owned file
] as const;

/**
 * True when this content carries ANY Pathrule output.
 *
 * Note the distinction that matters for deletion: this answers "did Pathrule
 * write something in here", NOT "does Pathrule own the whole file". A file with
 * an anchored region is mostly the USER's, so callers that delete must check
 * `stripRegion(body).trim() === ""` before removing anything. See
 * `isEntirelyPathrule`.
 */
export function isPathruleManaged(body: string): boolean {
  return PATHRULE_MANAGED_MARKERS.some((marker) => body.includes(marker));
}
