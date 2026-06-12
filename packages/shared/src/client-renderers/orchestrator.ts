// Browser-safe glue around the per-client renderers. `gatherLocalMultiClientInput`
// shapes the LocalBackend state for the renderers. `renderForClients` is the
// pure "render everything" entry point — both Electron main and the MCP server
// import this directly, then hand the file list off to the Node-only
// disk-writer. The cloud-edition gather lives in `orchestrator-cloud.ts` so this
// file (which the OSS local closure reaches) stays free of the @supabase import.

import type { CompiledKnowledgeNode, KnowledgeBackend, KnowledgeRenderMode } from "@pathrule/core";

import type { AgentTargetId } from "../skills/agent-targets.js";
import { getContextHandler, getWorkspaceOverviewHandler } from "../tools/tree.js";
import type { ToolContext } from "../tools/types.js";
import type { RecentActivityEntry } from "../claude-md-project.js";

import { getRenderer } from "./registry.js";
import type {
  ClientRendererSpec,
  MultiClientInput,
  RenderedFile,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Local (no-login) gather. Same renderers, backend-only sources.
// ─────────────────────────────────────────────────────────────────────────────

export interface GatherLocalArgs {
  /** SQLite-backed LocalBackend — the only data source in local mode. */
  backend: KnowledgeBackend;
  workspaceId: string;
  /** Display title for the companion files (LocalBackend.getWorkspaceName). */
  workspaceName: string;
  /** Local principal id stamped into the ToolContext. */
  userId: string;
}

/**
 * Local twin of the cloud `gatherMultiClientInput`: assembles the same
 * `MultiClientInput` the renderers consume, but sourced entirely from the
 * LocalBackend. Promoted rules are a cloud-only RPC and are omitted; recent
 * activities come from the local store. The renderers downstream are shared, so
 * the two editions never drift on output shape.
 */
export async function gatherLocalMultiClientInput(
  args: GatherLocalArgs,
): Promise<MultiClientInput> {
  const ctx: ToolContext = {
    userId: args.userId,
    workspaceId: args.workspaceId,
    backend: args.backend,
  };

  const [ctxRes, overviewRes, recentActivities, knowledge, knowledgeSlim] = await Promise.all([
    getContextHandler(ctx, { workspace_id: args.workspaceId, relative_path: "/" }),
    getWorkspaceOverviewHandler(ctx, { workspace_id: args.workspaceId }),
    fetchLocalRecentActivities(args.backend, args.workspaceId),
    fetchKnowledge(args.backend, args.workspaceId),
    fetchKnowledge(args.backend, args.workspaceId, "slim"),
  ]);

  if (!ctxRes.ok) {
    throw new Error(`getContext failed: ${ctxRes.error.message}`);
  }
  if (!overviewRes.ok) {
    throw new Error(`getWorkspaceOverview failed: ${overviewRes.error.message}`);
  }

  return {
    workspaceName: args.workspaceName,
    rootContext: {
      memories: ctxRes.data.memories.map((m) => ({
        id: m.id,
        title: m.title,
        preview: m.preview,
      })),
      rules: ctxRes.data.rules,
      skills: ctxRes.data.skills.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        source: s.source,
      })),
    },
    overview: overviewRes.data,
    recentActivities: recentActivities.length > 0 ? recentActivities : undefined,
    // Promoted rules are a cloud-only RPC; the local edition has no equivalent.
    promotedRules: undefined,
    knowledge: knowledge ?? undefined,
    knowledgeSlim: knowledgeSlim ?? undefined,
  };
}

/** Recent activity shaped from the local store (best-effort, never throws). */
async function fetchLocalRecentActivities(
  backend: KnowledgeBackend,
  workspaceId: string,
): Promise<RecentActivityEntry[]> {
  try {
    const acts = await backend.recentActivities({ workspaceId, relativePath: "" }, 8);
    return acts
      .filter((a) => a.domain && a.action)
      .map((a) => ({
        domain: a.domain as string,
        action: a.action as string,
        task_summary: a.taskSummary ?? "",
        created_at: a.createdAt,
      }));
  } catch {
    return [];
  }
}

/** Native Knowledge Compilation payload — optional backend capability.
 *  Exported so the cloud-edition gather (orchestrator-cloud.ts) reuses it. */
export async function fetchKnowledge(
  backend: KnowledgeBackend,
  workspaceId: string,
  mode?: KnowledgeRenderMode,
): Promise<CompiledKnowledgeNode[] | null> {
  if (typeof backend.buildKnowledgePayload !== "function") return null;
  try {
    const nodes = await backend.buildKnowledgePayload(workspaceId, mode);
    return nodes && nodes.length > 0 ? nodes : null;
  } catch {
    return null; // knowledge files are an enhancement, never load-bearing for sync
  }
}

export interface ClientRenderResult {
  client: AgentTargetId;
  files: RenderedFile[];
  ownedPaths: string[];
}

/** Pure: turn the resolved enabled list into per-client file artefacts.
 *  Caller handles disk I/O. `claude-code` is intentionally skipped here —
 *  CLAUDE.md is rendered by the dedicated `claude-md-project.ts` pipeline. */
/**
 * Clients that have a prompt-time body channel (the hook injects
 * relevance-ranked bodies on UserPromptSubmit). They render the SLIM router
 * file (titles + rules); the hook delivers bodies per prompt. Every other
 * client keeps the FULL file (unchanged) until its prompt-time channel is
 * individually verified, so nobody loses bodies.
 */
const SLIM_RENDER_CLIENTS = new Set<AgentTargetId>(["claude-code"]);

export function renderForClients(
  input: MultiClientInput,
  enabled: readonly AgentTargetId[],
): ClientRenderResult[] {
  const out: ClientRenderResult[] = [];
  for (const id of enabled) {
    const spec: ClientRendererSpec | null = getRenderer(id);
    if (!spec) continue;
    // Slim clients see the router projection in place of `knowledge`; the swap
    // is centralized here so per-client renderers stay knowledge-shape-agnostic.
    const clientInput: MultiClientInput =
      SLIM_RENDER_CLIENTS.has(id) && input.knowledgeSlim
        ? { ...input, knowledge: input.knowledgeSlim }
        : input;
    out.push({
      client: id,
      files: spec.render(clientInput),
      ownedPaths: spec.ownedPaths(clientInput),
    });
  }
  return out;
}
