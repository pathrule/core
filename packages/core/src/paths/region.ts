// Anchored regions: how Pathrule owns PART of a file whose name belongs to the
// user.
//
// Several agent clients read a fixed filename that predates Pathrule
// (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`). For those we cannot invent our own
// name, and taking the whole file means the user's instructions stop reaching
// the agent. So Pathrule owns a marked region inside the file and never touches
// a byte outside it.
//
// The anchors are HTML comments, which every client strips before the content
// reaches the model, so they cost nothing in context.
//
// Pure and deterministic: same inputs, same bytes.

import { isPathruleManaged } from "./ownership.js";

export interface RegionAnchors {
  begin: string;
  end: string;
}

/** The knowledge/protocol region Pathrule maintains inside a user-owned file. */
export const PATHRULE_REGION: RegionAnchors = {
  begin: "<!-- pathrule:begin (managed by Pathrule; edits inside this region are overwritten) -->",
  end: "<!-- pathrule:end -->",
};

/** True when the file already carries this region (both anchors, in order). */
export function hasRegion(body: string, anchors: RegionAnchors = PATHRULE_REGION): boolean {
  const begin = body.indexOf(anchors.begin);
  if (begin < 0) return false;
  return body.indexOf(anchors.end, begin + anchors.begin.length) > begin;
}

/**
 * Replace (or append) the anchored region, leaving everything outside it byte-identical.
 *
 *   1. both anchors present  → replace what is between them
 *   2. only `begin` present  → recover: treat the rest of the file as the region
 *   3. no anchors            → append the region at the end
 *
 * Always returns a body ending in exactly one newline.
 */
export function spliceRegion(
  body: string,
  sectionBody: string,
  anchors: RegionAnchors = PATHRULE_REGION,
): string {
  const region = `${anchors.begin}\n${sectionBody.trim()}\n${anchors.end}\n`;

  const beginIdx = body.indexOf(anchors.begin);
  const endIdx =
    beginIdx < 0 ? -1 : body.indexOf(anchors.end, beginIdx + anchors.begin.length);

  if (beginIdx >= 0 && endIdx > beginIdx) {
    const before = body.slice(0, beginIdx);
    const after = body.slice(endIdx + anchors.end.length);
    return normalizeTail(before + region + after.replace(/^\n+/, "\n"));
  }

  if (beginIdx >= 0) {
    // Truncated region (someone deleted the end anchor): rebuild from `begin`.
    return normalizeTail(body.slice(0, beginIdx) + region);
  }

  const base = body.trimEnd();
  return normalizeTail(base === "" ? region : `${base}\n\n${region}`);
}

/**
 * The file with Pathrule's region removed: the user's own content.
 * Used to tell "this file is entirely ours" from "the user owns part of it",
 * and by the recovery flow to show what a user would keep.
 */
export function stripRegion(body: string, anchors: RegionAnchors = PATHRULE_REGION): string {
  const beginIdx = body.indexOf(anchors.begin);
  if (beginIdx < 0) return body;
  const endIdx = body.indexOf(anchors.end, beginIdx + anchors.begin.length);
  const after = endIdx > beginIdx ? body.slice(endIdx + anchors.end.length) : "";
  return `${body.slice(0, beginIdx).trimEnd()}\n${after.trimStart()}`.trim();
}

/**
 * The full merge-region decision, in ONE place so every writer behaves
 * identically: the multi-client disk writer, the dedicated root-CLAUDE.md
 * writer, and the CLI.
 *
 *   - no file yet            → Pathrule's body alone, but still anchored, so a
 *                             user can add content around it later and the next
 *                             sync will respect it;
 *   - a file Pathrule fully  → replaced (nothing of the user's is in there).
 *     owned before anchors     Detected by banner, not by path.
 *     existed
 *   - anything else          → the user's file. Keep every byte outside the
 *                             region; refresh only the region.
 */
export function mergeRegionInto(
  existing: string | null,
  sectionBody: string,
  anchors: RegionAnchors = PATHRULE_REGION,
): string {
  if (existing === null) return spliceRegion("", sectionBody, anchors);
  const legacyPathruleOwned = !hasRegion(existing, anchors) && isPathruleManaged(existing);
  return spliceRegion(legacyPathruleOwned ? "" : existing, sectionBody, anchors);
}

/**
 * True when NOTHING in this file belongs to the user, so removing the file is
 * safe. The distinction from `isPathruleManaged` is load-bearing: a file with an
 * anchored region is mostly the user's, and deleting it because it "looks like
 * ours" would destroy their instructions. Any deletion path must gate on this.
 */
export function isEntirelyPathrule(
  body: string,
  anchors: RegionAnchors = PATHRULE_REGION,
): boolean {
  if (!isPathruleManaged(body)) return false;
  // A banner with no anchors is a file Pathrule owned outright, from before
  // regions existed. There is no user content in it to protect.
  if (!hasRegion(body, anchors)) return true;
  return stripRegion(body, anchors).trim() === "";
}

function normalizeTail(s: string): string {
  return `${s.replace(/\n+$/, "")}\n`;
}
