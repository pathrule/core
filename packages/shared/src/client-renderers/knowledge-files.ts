// Native Knowledge Compilation — shared helpers for the per-client renderers.
//
// The compiler (core/knowledge-compiler.ts) produces per-directory markdown
// knowledge sections; these helpers turn them into client files:
//   - root ("/") knowledge is spliced as a section into the client's main
//     protocol file (AGENTS.md / .mdc / copilot-instructions / CLAUDE.md),
//     because every client already auto-loads that file at turn zero;
//   - subdirectory knowledge becomes a separate path-scoped file in the
//     client's native format (nested AGENTS.md / CLAUDE.md, Cursor globs,
//     Copilot applyTo), which the client lazy-loads when work enters that path.
//
// Sweep correctness: `knowledgeOwnedPaths` derives the owned superset from the
// workspace overview (every directory node), not just from currently-emitted
// files — so a directory whose knowledge was removed gets its stale file
// cleaned up on the next sync.

import type { CompiledKnowledgeNode } from "@pathrule/core";
import type { MultiClientInput, RenderedFile } from "./types.js";

// Starts with the same "<!-- Pathrule managed" substring safe-write keys on,
// so backup-on-first-write recognizes our knowledge files as Pathrule-owned.
export const KNOWLEDGE_BANNER =
  "<!-- Pathrule managed (knowledge) — compiled from workspace knowledge; do not edit; regenerated on sync. -->";

/** "/apps/api" → "apps-api"; "/" → "root". Deterministic, filesystem-safe. */
export function knowledgeSlug(dirPath: string): string {
  if (dirPath === "/" || dirPath === "") return "root";
  return dirPath
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9/_-]+/g, "_")
    .replace(/\//g, "-");
}

/** Directory path without the leading slash, for building relative file paths. */
export function dirRelative(dirPath: string): string {
  return dirPath.replace(/^\/+/, "");
}

export function rootKnowledge(input: MultiClientInput): CompiledKnowledgeNode | null {
  return input.knowledge?.find((n) => n.dir_path === "/") ?? null;
}

export function subdirKnowledge(input: MultiClientInput): CompiledKnowledgeNode[] {
  return (input.knowledge ?? []).filter((n) => n.dir_path !== "/");
}

/**
 * Append the root knowledge section to a client's main protocol body.
 * Kept as a plain append (after promoted-rules splicing) so the protocol
 * text stays untouched and the section is easy to locate and re-splice.
 */
export function appendRootKnowledgeSection(body: string, input: MultiClientInput): string {
  const root = rootKnowledge(input);
  if (!root) return body;
  return (
    body.trimEnd() +
    "\n\n## Workspace knowledge (Pathrule)\n\n" +
    root.markdown.trimEnd() +
    "\n"
  );
}

/** A standalone knowledge file body (banner + compiled markdown). */
export function knowledgeFileBody(node: CompiledKnowledgeNode, title?: string): string {
  const heading = title ?? `# Project knowledge — ${node.dir_path}`;
  return `${KNOWLEDGE_BANNER}\n${heading}\n\n${node.markdown.trimEnd()}\n`;
}

/**
 * Owned-path superset for sweep: one potential knowledge file per directory
 * node in the workspace overview (plus the currently compiled dirs, in case
 * the overview is narrower than the knowledge set).
 */
export function knowledgeOwnedPaths(
  input: MultiClientInput,
  toPath: (dirPath: string, slug: string) => string | null,
): string[] {
  const dirs = new Set<string>();
  for (const n of input.overview ?? []) {
    const p = n.relative_path;
    if (typeof p === "string" && p.length > 0 && p !== "/") {
      // Only directory-looking nodes get standalone files; file nodes fold up.
      const last = p.split("/").filter(Boolean).pop() ?? "";
      if (!/\.[A-Za-z0-9]{1,8}$/.test(last)) dirs.add(p);
    }
  }
  for (const k of subdirKnowledge(input)) dirs.add(k.dir_path);
  const out: string[] = [];
  for (const d of [...dirs].sort()) {
    const p = toPath(d, knowledgeSlug(d));
    if (p) out.push(p);
  }
  return out;
}

/** Emit standalone files for every subdirectory knowledge node. */
export function renderKnowledgeFiles(
  input: MultiClientInput,
  toPath: (dirPath: string, slug: string) => string | null,
  wrap?: (node: CompiledKnowledgeNode, body: string) => string,
): RenderedFile[] {
  const out: RenderedFile[] = [];
  for (const node of subdirKnowledge(input)) {
    const path = toPath(node.dir_path, knowledgeSlug(node.dir_path));
    if (!path) continue;
    const base = knowledgeFileBody(node);
    out.push({ path, body: wrap ? wrap(node, base) : base });
  }
  return out;
}
