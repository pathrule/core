// SPDX-License-Identifier: Apache-2.0
/**
 * V30 outcome observation, end to end against a real SQLite LocalBackend:
 *   approved remedy -> delivered atom ids -> observeToolEvent(live tool event) -> append-only
 *   knowledge_evidence -> aggregate. Proves the hard gates: FALSE_USAGE = 0, scope + session
 *   isolation, multi-remedy ambiguity, narrow outcome, idempotency, no authority mutation.
 */
import { describe, it, expect } from "vitest";
import { LocalBackend } from "./local-backend.js";
import { type RemedyInput, type RemedyEvidenceState } from "@pathrule/shared/knowledge/remedy.js";
import { stampProposedRemedy } from "@pathrule/shared/knowledge/remedy-fingerprint.js";

function make() {
  let n = 0;
  const b = new LocalBackend(":memory:", { genId: () => `id-${++n}`, now: () => "2026-09-10T00:00:00.000Z" });
  b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
  return b;
}
async function approvedRemedy(b: LocalBackend, path: string, action_literals: string[], over: Partial<RemedyInput> & { evidence_state?: RemedyEvidenceState } = {}) {
  const node = await b.ensureNodeForPath("ws", path, "folder");
  await b.writeMemory({ workspaceId: "ws", nodeId: node.id, title: "t", content: `${action_literals.join(" ")} fixed the thing` });
  const memRow = (b as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db.prepare("SELECT id FROM memories ORDER BY created_at DESC LIMIT 1").get() as { id: string };
  const input: RemedyInput = {
    variant: "trouble", condition_evidence: ["the thing broke"], condition_normalized: null,
    action_evidence: action_literals, evidence_state: over.evidence_state ?? "OBSERVED_SUCCESS",
    source: { kind: "memory", id: memRow.id, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z",
  };
  const atom = await b.proposeRemedyAtom("ws", stampProposedRemedy(input, { now: "2026-09-01T00:00:00.000Z" }));
  await b.decideRemedyAtom("ws", atom.id, "approve", "user-1");
  return atom;
}

describe("V30 outcome observation (real backend)", () => {
  it("attributes a code-change remedy when its literal is inserted in-scope", async () => {
    const b = make();
    const atom = await approvedRemedy(b, "/apps/web", ["safeFoo()"]);
    const rs = await b.observeToolEvent("ws", "s1", [atom.id], { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" });
    expect(rs.find((r) => r.atom_id === atom.id)!.status).toBe("ATTRIBUTED");
    const ev = await b.listKnowledgeEvidence("ws", atom.id);
    expect(ev.map((e) => e.event_type)).toContain("usage_attributed");
    const agg = await b.aggregateAtomEvidence("ws", atom.id);
    expect(agg.attributed).toBe(1);
  });

  it("records NOTHING for an unrelated edit (lack of usage is not failure)", async () => {
    const b = make();
    const atom = await approvedRemedy(b, "/apps/web", ["safeFoo()"]);
    await b.observeToolEvent("ws", "s1", [atom.id], { kind: "edit", path: "/apps/web/x.ts", before: "a", after: "b" });
    expect(await b.listKnowledgeEvidence("ws", atom.id)).toHaveLength(0);
  });

  it("scope isolation: a sibling-path edit is never evidence", async () => {
    const b = make();
    const atom = await approvedRemedy(b, "/apps/web", ["safeFoo()"]);
    await b.observeToolEvent("ws", "s1", [atom.id], { kind: "edit", path: "/apps/api/s.ts", before: "x", after: "safeFoo()" });
    expect(await b.listKnowledgeEvidence("ws", atom.id)).toHaveLength(0);
  });

  it("multiple remedies inserted by one edit are AMBIGUOUS, none attributed", async () => {
    const b = make();
    const a1 = await approvedRemedy(b, "/apps/web", ["safeFoo()"]);
    const a2 = await approvedRemedy(b, "/apps/web", ["guard()"]);
    const rs = await b.observeToolEvent("ws", "s1", [a1.id, a2.id], { kind: "edit", path: "/apps/web/x.ts", before: "raw", after: "safeFoo(); guard();" });
    expect(rs.map((r) => r.status).sort()).toEqual(["AMBIGUOUS", "AMBIGUOUS"]);
    expect((await b.aggregateAtomEvidence("ws", a1.id)).attributed).toBe(0);
    expect((await b.aggregateAtomEvidence("ws", a1.id)).ambiguous).toBe(1);
  });

  it("a matched command exiting 0 records a narrow outcome_success", async () => {
    const b = make();
    const atom = await approvedRemedy(b, "/apps/web", ["pnpm test"]);
    await b.observeToolEvent("ws", "s1", [atom.id], { kind: "command", command: "pnpm test", exit_code: 0 });
    const types = (await b.listKnowledgeEvidence("ws", atom.id)).map((e) => e.event_type);
    expect(types).toContain("usage_attributed");
    expect(types).toContain("outcome_success");
    expect(await b.aggregateAtomEvidence("ws", atom.id)).toMatchObject({ attributed: 1, outcome_success: 1 });
  });

  it("a code-change attribution has NO outcome without a CHECK transition (stays unknown)", async () => {
    const b = make();
    const atom = await approvedRemedy(b, "/apps/web", ["safeFoo()"]);
    await b.observeToolEvent("ws", "s1", [atom.id], { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" });
    const types = (await b.listKnowledgeEvidence("ws", atom.id)).map((e) => e.event_type);
    expect(types).toContain("usage_attributed");
    expect(types).not.toContain("outcome_success");
    expect(types).not.toContain("outcome_failure");
  });

  it("a CHECK fail->pass after the attributed edit records outcome_success (STRONG)", async () => {
    const b = make();
    const atom = await approvedRemedy(b, "/apps/web", ["safeFoo()"]);
    await b.observeToolEvent("ws", "s1", [atom.id], { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" }, { was_failing: true, now_passing: true });
    expect((await b.aggregateAtomEvidence("ws", atom.id)).outcome_success).toBe(1);
  });

  it("is idempotent: the same event twice yields one evidence row", async () => {
    const b = make();
    const atom = await approvedRemedy(b, "/apps/web", ["safeFoo()"]);
    const ev = { kind: "edit" as const, path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" };
    await b.observeToolEvent("ws", "s1", [atom.id], ev);
    await b.observeToolEvent("ws", "s1", [atom.id], ev);
    expect((await b.listKnowledgeEvidence("ws", atom.id)).filter((e) => e.event_type === "usage_attributed")).toHaveLength(1);
  });

  it("session isolation: session B's event never attributes to session A's delivery id", async () => {
    const b = make();
    const atom = await approvedRemedy(b, "/apps/web", ["safeFoo()"]);
    await b.observeToolEvent("ws", "sB", [atom.id], { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" });
    const ev = await b.listKnowledgeEvidence("ws", atom.id);
    expect(ev.every((e) => e.delivery_id === `sB:${atom.id}` && e.session_id === "sB")).toBe(true);
  });

  it("a weak (non-deliverable) atom is never observed even if its literal is inserted", async () => {
    const b = make();
    const atom = await approvedRemedy(b, "/apps/web", ["safeFoo()"], { evidence_state: "ATTEMPTED" });
    await b.observeToolEvent("ws", "s1", [atom.id], { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" });
    expect(await b.listKnowledgeEvidence("ws", atom.id)).toHaveLength(0);
  });

  it("observation does NOT mutate atom authority, status, or evidence state", async () => {
    const b = make();
    const atom = await approvedRemedy(b, "/apps/web", ["safeFoo()"]);
    await b.observeToolEvent("ws", "s1", [atom.id], { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" }, { was_failing: true, now_passing: true });
    const [after] = await b.listRemedyAtomsForSubject("memory", atom.source.id);
    expect(after).toMatchObject({ authority: "human", status: "active", evidence_state: "OBSERVED_SUCCESS" });
  });
});
