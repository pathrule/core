// SPDX-License-Identifier: Apache-2.0
// Pure content-browsing contracts + helpers. Kept free of any backend
// dependency so the local `content --local` flow can reuse them without
// pulling in remote loaders. content.ts re-exports these, so other import
// paths keep working.

export type CliContentKind = "memory" | "rule" | "skill";

export interface CliContentOpenTarget {
  kind: "web" | "desktop-app";
  url: string;
  label: string;
  reason: "preferred" | "fallback" | "forced";
}

export interface CliContentItem {
  id: string;
  kind: CliContentKind;
  title: string;
  path: string | null;
  node_id: string | null;
  preview: string;
  updated_at: string | null;
  url: string;
  open_targets: CliContentOpenTarget[];
}

export interface CliContentReadResult extends CliContentItem {
  content: string;
}

export function normalizePathPrefix(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function pathMatches(path: string | null, prefix: string | null): boolean {
  if (!prefix) return true;
  if (!path) return false;
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function scoreItem(item: CliContentItem, needle: string): number {
  const title = item.title.toLowerCase();
  const previewText = item.preview.toLowerCase();
  const path = item.path?.toLowerCase() ?? "";
  let score = 0;
  if (title === needle) score += 100;
  if (title.includes(needle)) score += 30;
  if (path.includes(needle)) score += 15;
  if (previewText.includes(needle)) score += 10;
  return score;
}

export function preview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 160);
}

export function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 20;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}
