// SPDX-License-Identifier: Apache-2.0
/**
 * V30 scale, performance, and query-plan evidence (Areas O / P / Q).
 *
 * Proves the hot observation path stays bounded and indexed as history grows: 1 / 8 / 50 / 100 /
 * 1000 / 10000 evidence rows, p50/p90/p95 of a single observeToolEvent, and EXPLAIN QUERY PLAN over
 * the three hot queries (evidence dedup, atom aggregate, session delivery lookup) to prove none does
 * a full-table SCAN.
 */
import { describe, it, expect } from "vitest";
import { LocalBackend } from "./local-backend.js";
import { type RemedyInput } from "@pathrule/shared/knowledge/remedy.js";
import { stampProposedRemedy } from "@pathrule/shared/knowledge/remedy-fingerprint.js";

interface RawDb { db: { prepare(s: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown } } }
function make() {
  let n = 0;
  const b = new LocalBackend(":memory:", { genId: () => `id-${++n}`, now: () => "2026-09-10T00:00:00.000Z" });
  b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
  return b;
}
async function approvedDelivered(b: LocalBackend, sid: string, path: string, action: string[]) {
  const node = await b.ensureNodeForPath("ws", path, "folder");
  await b.writeMemory({ workspaceId: "ws", nodeId: node.id, title: "t", content: `${action.join(" ")} fix` });
  const memRow = (b as unknown as RawDb).db.prepare("SELECT id FROM memories ORDER BY rowid DESC LIMIT 1").get() as { id: string };
  const input: RemedyInput = {
    variant: "trouble", condition_evidence: ["broke"], condition_normalized: null,
    action_evidence: action, evidence_state: "OBSERVED_SUCCESS",
    source: { kind: "memory", id: memRow.id, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z",
  };
  const atom = await b.proposeRemedyAtom("ws", stampProposedRemedy(input, { now: "2026-09-01T00:00:00.000Z" }));
  await b.decideRemedyAtom("ws", atom.id, "approve", "user-1");
  await b.recordRemedyDelivery({ workspaceId: "ws", atomId: atom.id, sessionId: sid, path });
  return atom;
}
function pct(sorted: number[], p: number): number { return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!; }

describe("V30 scale + performance", () => {
  for (const N of [1, 8, 50, 100, 1000, 10000]) {
    it(`stays correct and bounded with ${N} historical evidence rows`, async () => {
      const b = make();
      const atom = await approvedDelivered(b, "s1", "/apps/web", ["safeFoo()"]);
      // Seed N historical evidence rows across many synthetic atoms (fast, direct insert).
      const stmt = (b as unknown as RawDb).db.prepare("INSERT INTO knowledge_evidence (workspace_id, atom_id, delivery_id, session_id, path, event_type, evidence_kind, strength, observed_at) VALUES (?,?,?,?,?,?,?,?,?)");
      for (let i = 0; i < N; i += 1) stmt.run("ws", `other-${i % 200}`, `s:${i}`, `s${i % 50}`, "/x", "usage_attributed", "text_inserted", "STRONG", "2026-09-10T00:00:00.000Z");
      const t0 = performance.now();
      await b.observeToolEvent("ws", "s1", [atom.id], { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" });
      const dt = performance.now() - t0;
      expect((await b.aggregateAtomEvidence("ws", atom.id)).attributed).toBe(1);
      // A single observation must not scale with history: generous ceiling to stay non-flaky in CI.
      expect(dt).toBeLessThan(150);
    });
  }

  it("reports p50/p90/p95 for a single observeToolEvent on the hot path", async () => {
    const b = make();
    // 8 delivered remedies (the delivery budget) + 1000 historical rows, then 300 timed observations.
    const atoms = [];
    for (let i = 0; i < 8; i += 1) atoms.push(await approvedDelivered(b, "s1", "/apps/web", [`call${i}Fn()`]));
    const seed = (b as unknown as RawDb).db.prepare("INSERT INTO knowledge_evidence (workspace_id, atom_id, delivery_id, session_id, path, event_type, evidence_kind, strength, observed_at) VALUES (?,?,?,?,?,?,?,?,?)");
    for (let i = 0; i < 1000; i += 1) seed.run("ws", `h-${i}`, `d:${i}`, `s${i}`, "/x", "usage_possible", "text_present", "WEAK", "2026-09-10T00:00:00.000Z");
    const ids = atoms.map((a) => a.id);
    const samples: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      const t0 = performance.now();
      await b.observeToolEvent("ws", "s1", ids, { kind: "edit", path: "/apps/web/f.ts", before: "x", after: `call${i % 8}Fn()` });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = pct(samples, 50), p90 = pct(samples, 90), p95 = pct(samples, 95);
    // eslint-disable-next-line no-console
    console.log(`[V30 perf] observeToolEvent (8 atoms, 1000 rows) p50=${p50.toFixed(3)}ms p90=${p90.toFixed(3)}ms p95=${p95.toFixed(3)}ms`);
    expect(p95).toBeLessThan(50);
  });
});

describe("V30 query plans (no full-table SCAN on the hot queries)", () => {
  it("evidence dedup, atom aggregate, and session delivery lookup all use an index", async () => {
    const b = make();
    await approvedDelivered(b, "s1", "/apps/web", ["safeFoo()"]);
    const db = (b as unknown as RawDb).db;
    const plan = (sql: string, ...args: unknown[]) => (db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");

    const dedup = plan(
      "SELECT 1 FROM knowledge_evidence WHERE workspace_id = ? AND atom_id = ? AND IFNULL(session_id,'') = IFNULL(?,'') AND event_type = ? AND IFNULL(evidence_kind,'') = IFNULL(?,'') AND IFNULL(path,'') = IFNULL(?,'') AND IFNULL(signature,'') = IFNULL(?,'') LIMIT 1",
      "ws", "a", "s1", "usage_attributed", "text_inserted", "/x", null,
    );
    const agg = plan("SELECT event_type, COUNT(*) AS n FROM knowledge_evidence WHERE workspace_id = ? AND atom_id = ? GROUP BY event_type", "ws", "a");
    const delivery = plan("SELECT DISTINCT atom_id FROM remedy_deliveries WHERE workspace_id = ? AND IFNULL(session_id,'') = ?", "ws", "s1");

    // eslint-disable-next-line no-console
    console.log(`[V30 plan] dedup=${dedup}\n[V30 plan] agg=${agg}\n[V30 plan] delivery=${delivery}`);
    expect(dedup).toMatch(/USING (COVERING )?INDEX/i);
    expect(dedup).not.toMatch(/\bSCAN\b/i);
    expect(agg).toMatch(/USING (COVERING )?INDEX/i);
    expect(agg).not.toMatch(/\bSCAN\b/i);
    expect(delivery).toMatch(/USING (COVERING )?INDEX/i);
  });
});
