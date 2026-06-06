// SPDX-License-Identifier: Apache-2.0
// Pure node-path contracts, split out of nodes.ts so the core backends +
// local CLI can import them without dragging the database materialisation
// code (and its client-SDK dependency) into this shared export set.
// nodes.ts re-exports these — every existing import path keeps working.

import type { NodeType } from "../node-types.js";

export interface MaterialisedNode {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  name: string;
  type: NodeType;
  relative_path: string;
}

/**
 * Normalises a caller-supplied path to the canonical workspace form:
 *   ""                -> "/"            (root)
 *   "/"               -> "/"
 *   "apps/mobile"     -> "/apps/mobile"
 *   "/apps/mobile/"   -> "/apps/mobile"
 *   "//apps"          -> "/apps"        (legacy double-slash tolerance)
 */
export function normalizeNodePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "/") return "/";
  const withLead = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
  const collapsed = withLead.replace(/\/+/g, "/");
  return collapsed === "/" ? "/" : collapsed.replace(/\/$/, "");
}

/** Heuristic: "name.ext" with 1-8 char extension is a file; anything else a folder. */
export function guessLeafType(relativePath: string): NodeType {
  const segments = relativePath.split("/").filter((s) => s.length > 0);
  const last = segments[segments.length - 1] ?? "";
  return /\.[A-Za-z0-9]{1,8}$/.test(last) ? "file" : "folder";
}
