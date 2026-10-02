// SPDX-License-Identifier: Apache-2.0
// One browser-safe delivery decision for native files and the Node-only hook index.
import type { HookIndexInput } from "./hook-index.js";
import type { KnowledgeEntry } from "@pathrule/shared/agent-ir/agent-ir.js";
import { entryKnowledgeText, renderAdvisoryLine, renderSelectionLine, renderProcedureLine, renderContextLine, renderRationaleLine } from "@pathrule/shared/agent-ir/entry-rendering.js";
import { planCompiledDelivery, type CompiledDeliveryPlan, type SourcedAdvisoryLine } from "@pathrule/shared/agent-ir/compiled-delivery.js";

/** The inputs the compiled-or-source decision reads: the advisories, and the memory text each is judged against. */
export type CompiledDeliveryInput = Pick<
  HookIndexInput,
  "advisories" | "selections" | "procedures" | "contexts" | "rationales" | "advisorySources"
> & { memories: ReadonlyArray<{ id: string; content: string }> };

/**
 * Every approved advisory as the exact line the agent receives, in delivery order (remedy, selection,
 * procedure, context, rationale), with its scope, the knowledge the line carries, and its source memory.
 * The ONE place lines are rendered, so the gate judges the same lines the index ships.
 */
export function sourcedAdvisoryLines(input: CompiledDeliveryInput): Array<SourcedAdvisoryLine & { scope: string | null }> {
  const sources = input.advisorySources ?? {};
  const out: Array<SourcedAdvisoryLine & { scope: string | null }> = [];
  const add = (entry: KnowledgeEntry, line: string): void => {
    out.push({ ref: entry.ref, line, knowledge: entryKnowledgeText(entry), sourceMemoryId: sources[entry.ref] ?? null, scope: entry.scope });
  };
  for (const a of input.advisories ?? []) add(a, renderAdvisoryLine(a));
  for (const s of input.selections ?? []) add(s, renderSelectionLine(s));
  for (const p of input.procedures ?? []) add(p, renderProcedureLine(p));
  for (const c of input.contexts ?? []) add(c, renderContextLine(c));
  for (const r of input.rationales ?? []) add(r, renderRationaleLine(r));
  return out;
}

/**
 * Compiled form or source, per memory (`planCompiledDelivery`). The index, the warehouse and the native
 * knowledge files all read this one plan, so a memory is delivered the same way on every channel, and
 * Studio's turn context reads it through `LocalBackend.compiledMemoryDeliveries`.
 */
export function compiledDeliveryPlan(input: CompiledDeliveryInput): CompiledDeliveryPlan {
  return planCompiledDelivery(sourcedAdvisoryLines(input), input.memories);
}

/** What a memory's body slot carries: its compiled form when the gate cleared it, else the memory. */
export function deliveredMemoryBody(m: { id: string; content: string }, plan: CompiledDeliveryPlan): string {
  return plan.compiled.get(m.id)?.text ?? m.content;
}

