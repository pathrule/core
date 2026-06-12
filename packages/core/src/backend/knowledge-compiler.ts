// SPDX-License-Identifier: Apache-2.0
/**
 * Native Knowledge Compilation — the pure core that turns the
 * workspace's path-scoped knowledge into per-directory markdown sections,
 * ready for each client renderer to wrap in its native instruction format
 * (directory CLAUDE.md / nested AGENTS.md / Cursor .mdc globs / Copilot
 * applyTo instructions / Windsurf rules).
 *
 * Why: every supported agent already has a native, turn-zero, cached,
 * path-scoped instruction channel. Measured head-to-head, knowledge delivered
 * there suppresses exploration (3-8 turns vs 12-19) while hook/MCP retrieval
 * does not. So the compiler puts the knowledge itself into that channel;
 * hooks keep only guard + live-delta duties.
 *
 * Pure and deterministic: same input, same bytes. No I/O, no clock.
 */
import type { HookIndexInput } from "./hook-index.js";

/** Per-directory budget for compiled knowledge (chars ≈ tokens × 4). */
const DIR_BUDGET_CHARS = 12_000;
/** The root file is read in every session — keep it lean. */
const ROOT_BUDGET_CHARS = 6_000;

const AUTHORITY_NOTE =
  "> Authoritative, up-to-date project knowledge for this path (maintained by Pathrule). " +
  "Use it directly; do not re-derive these facts by exploring files.";

/**
 * Render mode. `full` (default) compiles every item's BODY into the file —
 * the proven turn-zero delivery for clients whose only channel is the file.
 * `slim` turns the file into a ROUTER: memory/skill become a TITLE index (their
 * bodies are delivered per-prompt by the hook's relevance top-k), while RULES
 * stay full (floored — always present at turn zero). Used for clients with a
 * prompt-time body channel (Claude); other clients stay `full` until verified.
 */
export type KnowledgeRenderMode = "full" | "slim";

export interface AssembleKnowledgeOptions {
  mode?: KnowledgeRenderMode;
}

export interface CompiledKnowledgeNode {
  /** Always a directory path: "/" or "/lib". File-level knowledge folds into its parent dir. */
  dir_path: string;
  /** The knowledge sections (markdown, no client-specific wrapper/banner). */
  markdown: string;
  /** Memory ids whose FULL BODY is in this file (full mode). Empty in slim mode. */
  memory_ids: string[];
  rule_ids: string[];
  /** Skill ids whose FULL BODY is in this file (full mode). Empty in slim mode. */
  skill_ids: string[];
  /** Slim mode: memory ids whose TITLE is indexed here but body is NOT (hook delivers it). */
  indexed_memory_ids?: string[];
  /** Slim mode: skill ids whose name is indexed here but body is NOT. */
  indexed_skill_ids?: string[];
  /** True when the dir budget forced dropping lower-priority items. */
  truncated: boolean;
}

interface DirBucket {
  rules: Array<{ id: string; name: string; content: string; priority: string; at?: string }>;
  memories: Array<{ id: string; title: string; content: string; at?: string }>;
  skills: Array<{ id: string; name: string; content: string }>;
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** "/lib/route.js" → { dir: "/lib", leaf: "route.js" }; "/lib" → { dir: "/lib" }. */
function toDirPath(nodePath: string): { dir: string; leaf?: string } {
  const clean = nodePath === "" ? "/" : nodePath;
  const last = clean.split("/").filter(Boolean).pop() ?? "";
  const looksLikeFile = /\.[A-Za-z0-9]{1,8}$/.test(last);
  if (!looksLikeFile) return { dir: clean || "/" };
  const idx = clean.lastIndexOf("/");
  const dir = idx <= 0 ? "/" : clean.slice(0, idx);
  return { dir, leaf: last };
}

export function assembleKnowledgeNodes(
  input: HookIndexInput,
  opts?: AssembleKnowledgeOptions,
): CompiledKnowledgeNode[] {
  const mode: KnowledgeRenderMode = opts?.mode ?? "full";
  const buckets = new Map<string, DirBucket>();
  const bucket = (dir: string): DirBucket => {
    let b = buckets.get(dir);
    if (!b) {
      b = { rules: [], memories: [], skills: [] };
      buckets.set(dir, b);
    }
    return b;
  };

  for (const r of input.rules) {
    const targets = r.scope_type === "project" || r.node_paths.length === 0 ? ["/"] : r.node_paths;
    for (const np of targets) {
      const { dir, leaf } = toDirPath(np);
      bucket(dir).rules.push({
        id: r.id,
        name: leaf ? `${r.name} (${leaf})` : r.name,
        content: r.content,
        priority: r.priority,
        at: leaf,
      });
    }
  }
  for (const m of input.memories) {
    const { dir, leaf } = toDirPath(m.node_path);
    bucket(dir).memories.push({
      id: m.id,
      title: leaf ? `${m.title} (${leaf})` : m.title,
      content: m.content,
      at: leaf,
    });
  }
  for (const s of input.skills) {
    const targets = s.node_paths && s.node_paths.length > 0 ? s.node_paths : ["/"];
    for (const np of targets) {
      const { dir } = toDirPath(np);
      bucket(dir).skills.push({ id: s.id, name: s.name, content: s.content });
    }
  }

  const out: CompiledKnowledgeNode[] = [];
  for (const [dir, b] of [...buckets.entries()].sort((a, z) => a[0].localeCompare(z[0]))) {
    if (b.rules.length === 0 && b.memories.length === 0 && b.skills.length === 0) continue;

    // Deterministic priority order: rules high→low then by id; memories/skills by id.
    b.rules.sort(
      (a, z) =>
        (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[z.priority] ?? 3) ||
        a.id.localeCompare(z.id),
    );
    b.memories.sort((a, z) => a.id.localeCompare(z.id));
    b.skills.sort((a, z) => a.id.localeCompare(z.id));

    const budget = dir === "/" ? ROOT_BUDGET_CHARS : DIR_BUDGET_CHARS;
    const lines: string[] = [AUTHORITY_NOTE, ""];
    const memoryIds: string[] = [];
    const ruleIds: string[] = [];
    const skillIds: string[] = [];
    const indexedMemoryIds: string[] = [];
    const indexedSkillIds: string[] = [];
    let used = lines.join("\n").length;
    let truncated = false;

    const tryPush = (block: string): boolean => {
      const cost = block.length + 1;
      if (used + cost > budget) {
        truncated = true;
        return false;
      }
      lines.push(block);
      used += cost;
      return true;
    };

    // Rules are FULL in BOTH modes — they are floored (always present at turn zero).
    if (b.rules.length > 0) {
      tryPush("## Rules (must follow)\n");
      for (const r of b.rules) {
        if (tryPush(`### ${r.name}\n${r.content.trim()}\n`)) ruleIds.push(r.id);
      }
    }
    if (b.memories.length > 0) {
      if (mode === "slim") {
        // Router: index titles only; the hook delivers the prompt-relevant bodies.
        tryPush("## Knowledge index (bodies delivered per prompt by Pathrule)\n");
        for (const m of b.memories) {
          if (tryPush(`- ${m.title}`)) indexedMemoryIds.push(m.id);
        }
      } else {
        tryPush("## Knowledge & decisions\n");
        for (const m of b.memories) {
          if (tryPush(`### ${m.title}\n${m.content.trim()}\n`)) memoryIds.push(m.id);
        }
      }
    }
    if (b.skills.length > 0) {
      if (mode === "slim") {
        tryPush("## Available procedures (invoke with ::name)\n");
        for (const s of b.skills) {
          if (tryPush(`- ${s.name}`)) indexedSkillIds.push(s.id);
        }
      } else {
        tryPush("## Procedures (follow step by step)\n");
        for (const s of b.skills) {
          if (tryPush(`### ${s.name}\n${s.content.trim()}\n`)) skillIds.push(s.id);
        }
      }
    }
    if (truncated) {
      lines.push(
        "\n_Some items were omitted for size; ask Pathrule (pathrule_get_context) for the rest._",
      );
    }

    out.push({
      dir_path: dir,
      markdown: lines.join("\n").trimEnd() + "\n",
      memory_ids: memoryIds,
      rule_ids: ruleIds,
      skill_ids: skillIds,
      indexed_memory_ids: indexedMemoryIds,
      indexed_skill_ids: indexedSkillIds,
      truncated,
    });
  }
  return out;
}
