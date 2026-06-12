// Common contract for the per-client cloud-driven renderers. Each renderer
// is pure: same `MultiClientInput` produces the same bytes every time. The
// Electron-side `multi-client-md.ts` orchestrator does the disk I/O.

import type { CompiledKnowledgeNode } from "@pathrule/core";
import type { WorkspaceOverviewNode } from "../tools/tree.js";
import type { RecentActivityEntry, RootMemory, RootRule, RootSkill } from "../claude-md-project.js";

// ─────────────────────────────────────────────────────────────────────────────
// Promoted Rules Bundle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single entry in the promoted rules bundle — one rule with
 * injection_strategy='claude_md_only', rendered into every per-client
 * instructions file once per session.
 */
export interface PromotedRuleBundleEntry {
  rule_id: string;
  name: string;
  display_summary: string;
  priority: "critical" | "high" | "medium" | "low";
  scope_type: "project" | "folder" | "file_type";
  promoted_at: string | null;
}

/**
 * The full bundle returned by pathrule_get_promoted_rules_bundle, plus
 * a sha256-based signature used as a verification handshake between the
 * server and the agent. The signature is embedded in the instructions file
 * as an HTML comment and returned by pathrule_get_context so the agent
 * can detect stale files.
 */
export interface PromotedRulesBundle {
  workspace_id: string;
  entries: PromotedRuleBundleEntry[];
  /** sha256 of the canonicalized entry list (rule_id + display_summary, sorted). */
  signature: string;
  rendered_at: string;
}

export interface MultiClientInput {
  workspaceName: string;
  rootContext: {
    memories: RootMemory[];
    rules: RootRule[];
    skills: RootSkill[];
  };
  overview: WorkspaceOverviewNode[];
  recentActivities?: RecentActivityEntry[];
  /** Promoted rules bundle; undefined when feature flag is off or no promoted rules exist. */
  promotedRules?: PromotedRulesBundle;
  /**
   * Native Knowledge Compilation: per-directory knowledge sections (full
   * bodies, budgeted) from KnowledgeBackend.buildKnowledgePayload. When
   * present, renderers emit path-scoped knowledge files in each client's
   * native instruction format; when absent, companions stay protocol-only.
   */
  knowledge?: CompiledKnowledgeNode[];
  /**
   * The SLIM (router) projection of the same knowledge: memory/skill as a
   * title index, rules full. Clients with a prompt-time body channel (Claude)
   * render from this; the hook then delivers the prompt-relevant bodies. Absent
   * ⇒ slim clients fall back to `knowledge` (full).
   */
  knowledgeSlim?: CompiledKnowledgeNode[];
}

export interface RenderedFile {
  /** Workspace-root-relative path. */
  path: string;
  /** Full file body, ending in a single trailing newline. */
  body: string;
}

export type ClientRenderer = (input: MultiClientInput) => RenderedFile[];

/**
 * Files this renderer "owns" — the orchestrator deletes any of these that
 * the renderer no longer emits, so a tool that's enabled then disabled then
 * re-enabled lands back in a clean state. Paths returned here MUST be a
 * superset of every path the renderer's `render` function ever emits.
 */
export type ClientOwnedPaths = (input: MultiClientInput) => string[];

export interface ClientRendererSpec {
  /** Stable agent target id. */
  id: string;
  render: ClientRenderer;
  ownedPaths: ClientOwnedPaths;
}
