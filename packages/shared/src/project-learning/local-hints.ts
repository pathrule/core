import type { ContextAdvisory, RationaleAdvisory } from "../agent-ir/agent-ir.js";
import { learningScopesOverlap, validLearningScope } from "./claims.js";

/** Read-only capability of the local atom store. Never part of the cloud claim contract. */
export interface ExistingLearningHintStore {
  contextsForHookIndex?(workspaceId: string): ContextAdvisory[];
  rationalesForHookIndex?(workspaceId: string): RationaleAdvisory[];
}
export interface ExistingLearningHint {
  kind: "context" | "rationale";
  ref: string;
  scope: string;
  text: string;
  origin: "existing_approved_local_atom";
}

/** The existing projectors enforce human approval. No model probe, spawn or extraction. */
export function existingLearningHints(
  store: ExistingLearningHintStore,
  workspaceId: string,
  scope: string,
): ExistingLearningHint[] {
  try {
    const rows = [
      ...(store.contextsForHookIndex?.(workspaceId) ?? [])
        .filter((item) => item.fact_grounded)
        .map((item) => ({
          kind: "context" as const,
          ref: item.ref,
          scope: item.scope,
          text: item.fact,
        })),
      ...(store.rationalesForHookIndex?.(workspaceId) ?? []).map((item) => ({
        kind: "rationale" as const,
        ref: item.ref,
        scope: item.scope,
        text: `${item.subject}: ${item.reason}`,
      })),
    ];
    const result: ExistingLearningHint[] = [];
    for (const row of rows) {
      const path = row.scope ?? "/";
      if (
        !validLearningScope(path) ||
        !learningScopesOverlap(scope, path) ||
        !row.text ||
        row.text.length > 600
      )
        continue;
      if (result.some((item) => item.ref === row.ref)) continue;
      const candidate = { ...row, scope: path, origin: "existing_approved_local_atom" as const };
      if (JSON.stringify([...result, candidate]).length > 1600) continue;
      result.push(candidate);
      if (result.length === 4) break;
    }
    return result;
  } catch {
    return [];
  }
}
