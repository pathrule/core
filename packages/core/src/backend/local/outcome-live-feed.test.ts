// SPDX-License-Identifier: Apache-2.0
/**
 * V30 LIVE runtime feed, end to end through the real production drain.
 *
 * The standalone hook captures each observable tool event to a local `knowledge-observations.jsonl`.
 * `ingestObservationsFromDisk` is the backend seam that turns that file into categorical evidence with
 * NO manual `observeToolEvent` call: this suite writes the exact JSONL the hook writes and drains it,
 * proving the same hard gates on the live path (positive, negative, ambiguous, scope + session
 * isolation, idempotency, restart), plus condition observation, error persistence, and the debug trace.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "./local-backend.js";
import { type RemedyInput, type RemedyEvidenceState } from "@pathrule/shared/knowledge/remedy.js";
import { stampProposedRemedy } from "@pathrule/shared/knowledge/remedy-fingerprint.js";
import type { ObservedEvent } from "@pathrule/shared/agent-ir/outcome.js";

const dirs: string[] = [];
function scratch(): string { const d = mkdtempSync(join(tmpdir(), "pr-v30-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });

function make(dbPath = ":memory:") {
  let n = 0;
  const b = new LocalBackend(dbPath, { genId: () => `id-${++n}`, now: () => "2026-09-10T00:00:00.000Z" });
  b.registerWorkspace({ workspaceId: "ws", localRootPath: "/repo" });
  return b;
}
async function deliveredRemedy(b: LocalBackend, sid: string, path: string, action: string[], over: Partial<RemedyInput> & { evidence_state?: RemedyEvidenceState; condition?: string[] } = {}) {
  const node = await b.ensureNodeForPath("ws", path, "folder");
  await b.writeMemory({ workspaceId: "ws", nodeId: node.id, title: "t", content: `${action.join(" ")} fixed it` });
  const memRow = (b as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db.prepare("SELECT id FROM memories ORDER BY rowid DESC LIMIT 1").get() as { id: string };
  const input: RemedyInput = {
    variant: "trouble", condition_evidence: over.condition ?? ["it broke"], condition_normalized: null,
    action_evidence: action, evidence_state: over.evidence_state ?? "OBSERVED_SUCCESS",
    source: { kind: "memory", id: memRow.id, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z",
  };
  const atom = await b.proposeRemedyAtom("ws", stampProposedRemedy(input, { now: "2026-09-01T00:00:00.000Z" }));
  await b.decideRemedyAtom("ws", atom.id, "approve", "user-1");
  await b.recordRemedyDelivery({ workspaceId: "ws", atomId: atom.id, sessionId: sid, path });
  return atom;
}
function ledger(dir: string, lines: Array<{ sid: string; event: ObservedEvent; check?: { was_failing: boolean; now_passing: boolean } }>): string {
  const f = join(dir, "knowledge-observations.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify({ sid: l.sid, at: "2026-09-10T00:00:01.000Z", event: l.event, check: l.check })).join("\n") + "\n");
  return f;
}

describe("V30 live feed: drain a real observation ledger", () => {
  it("POSITIVE: a captured in-scope insertion becomes ATTRIBUTED evidence with no manual call", async () => {
    const b = make();
    const atom = await deliveredRemedy(b, "s1", "/apps/web", ["safeFoo()"]);
    const f = ledger(scratch(), [{ sid: "s1", event: { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" } }]);
    const res = await b.ingestObservationsFromDisk("ws", f);
    expect(res.observed).toBe(1);
    expect((await b.aggregateAtomEvidence("ws", atom.id)).attributed).toBe(1);
  });

  it("NEGATIVE: a captured unrelated edit yields no evidence (lack of usage is not failure)", async () => {
    const b = make();
    const atom = await deliveredRemedy(b, "s1", "/apps/web", ["safeFoo()"]);
    const f = ledger(scratch(), [{ sid: "s1", event: { kind: "edit", path: "/apps/web/x.ts", before: "a", after: "b" } }]);
    await b.ingestObservationsFromDisk("ws", f);
    expect(await b.listKnowledgeEvidence("ws", atom.id)).toHaveLength(0);
  });

  it("AMBIGUOUS: one captured edit inserting two remedies attributes neither", async () => {
    const b = make();
    const a1 = await deliveredRemedy(b, "s1", "/apps/web", ["safeFoo()"]);
    const a2 = await deliveredRemedy(b, "s1", "/apps/web", ["guard()"]);
    const f = ledger(scratch(), [{ sid: "s1", event: { kind: "edit", path: "/apps/web/x.ts", before: "raw", after: "safeFoo(); guard();" } }]);
    await b.ingestObservationsFromDisk("ws", f);
    expect((await b.aggregateAtomEvidence("ws", a1.id)).attributed).toBe(0);
    expect((await b.aggregateAtomEvidence("ws", a1.id)).ambiguous).toBe(1);
    expect((await b.aggregateAtomEvidence("ws", a2.id)).ambiguous).toBe(1);
  });

  it("SCOPE ISOLATION: a captured edit outside scope is never evidence", async () => {
    const b = make();
    const atom = await deliveredRemedy(b, "s1", "/apps/web", ["safeFoo()"]);
    const f = ledger(scratch(), [{ sid: "s1", event: { kind: "edit", path: "/apps/api/x.ts", before: "a", after: "safeFoo()" } }]);
    await b.ingestObservationsFromDisk("ws", f);
    expect(await b.listKnowledgeEvidence("ws", atom.id)).toHaveLength(0);
  });

  it("SESSION ISOLATION: an event whose session has no delivery is skipped, not cross-attributed", async () => {
    const b = make();
    const atom = await deliveredRemedy(b, "sA", "/apps/web", ["safeFoo()"]);
    // Session sB was never delivered this atom; its identical edit must not attribute to sA.
    const f = ledger(scratch(), [{ sid: "sB", event: { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" } }]);
    const res = await b.ingestObservationsFromDisk("ws", f);
    expect(res.skipped).toBe(1);
    expect(await b.listKnowledgeEvidence("ws", atom.id)).toHaveLength(0);
  });

  it("CONCURRENT SESSIONS: two sessions in one ledger stay isolated to their own deliveries", async () => {
    const b = make();
    const aWeb = await deliveredRemedy(b, "sA", "/apps/web", ["webCall()"]);
    const aApi = await deliveredRemedy(b, "sB", "/apps/api", ["apiCall()"]);
    const f = ledger(scratch(), [
      { sid: "sA", event: { kind: "edit", path: "/apps/web/x.ts", before: "raw", after: "webCall()" } },
      { sid: "sB", event: { kind: "edit", path: "/apps/api/y.ts", before: "raw", after: "apiCall()" } },
      // sA editing an api file cannot attribute apiCall() (delivered only to sB, and out of sA scope)
      { sid: "sA", event: { kind: "edit", path: "/apps/api/z.ts", before: "raw", after: "apiCall()" } },
    ]);
    await b.ingestObservationsFromDisk("ws", f);
    const evA = await b.listKnowledgeEvidence("ws", aWeb.id);
    const evB = await b.listKnowledgeEvidence("ws", aApi.id);
    expect(evA.every((e) => e.session_id === "sA")).toBe(true);
    expect(evB.every((e) => e.session_id === "sB")).toBe(true);
    expect((await b.aggregateAtomEvidence("ws", aWeb.id)).attributed).toBe(1);
    expect((await b.aggregateAtomEvidence("ws", aApi.id)).attributed).toBe(1);
  });

  it("IDEMPOTENT: draining consumes the file; a re-drain of the same file is a no-op", async () => {
    const b = make();
    const atom = await deliveredRemedy(b, "s1", "/apps/web", ["safeFoo()"]);
    const f = ledger(scratch(), [{ sid: "s1", event: { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" } }]);
    await b.ingestObservationsFromDisk("ws", f);
    expect(existsSync(f)).toBe(false);
    expect(existsSync(`${f}.consumed`)).toBe(true);
    const again = await b.ingestObservationsFromDisk("ws", f); // file gone
    expect(again.observed).toBe(0);
    expect((await b.aggregateAtomEvidence("ws", atom.id)).attributed).toBe(1); // still exactly one
  });

  it("IDEMPOTENT: even re-observing the identical event twice yields one evidence row", async () => {
    const b = make();
    const atom = await deliveredRemedy(b, "s1", "/apps/web", ["safeFoo()"]);
    const dir = scratch();
    const evLine = { sid: "s1", event: { kind: "edit" as const, path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" } };
    ledger(dir, [evLine]);
    await b.ingestObservationsFromDisk("ws", join(dir, "knowledge-observations.jsonl"));
    ledger(dir, [evLine]); // a second capture of the same event (e.g. a retried hook)
    await b.ingestObservationsFromDisk("ws", join(dir, "knowledge-observations.jsonl"));
    expect((await b.listKnowledgeEvidence("ws", atom.id)).filter((e) => e.event_type === "usage_attributed")).toHaveLength(1);
  });

  it("COMMAND: a captured command exiting 0 records a narrow outcome_success on the live path", async () => {
    const b = make();
    const atom = await deliveredRemedy(b, "s1", "/apps/web", ["pnpm test"]);
    const f = ledger(scratch(), [{ sid: "s1", event: { kind: "command", command: "pnpm test", exit_code: 0 } }]);
    await b.ingestObservationsFromDisk("ws", f);
    expect(await b.aggregateAtomEvidence("ws", atom.id)).toMatchObject({ attributed: 1, outcome_success: 1 });
  });

  it("MALFORMED lines are skipped, never fatal", async () => {
    const b = make();
    await deliveredRemedy(b, "s1", "/apps/web", ["safeFoo()"]);
    const dir = scratch();
    const f = join(dir, "knowledge-observations.jsonl");
    writeFileSync(f, "not json\n" + JSON.stringify({ sid: "s1", event: { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" } }) + "\n{bad\n");
    const res = await b.ingestObservationsFromDisk("ws", f);
    expect(res.observed).toBe(1);
    expect(res.skipped).toBe(2);
  });
});

describe("V30 condition observation + error persistence on the live path", () => {
  it("a failing command matching the remedy condition records condition_observed with a signature", async () => {
    const b = make();
    const atom = await deliveredRemedy(b, "s1", "/apps/web", ["fixIt()"], { condition: ["pnpm typecheck"] });
    const f = ledger(scratch(), [{ sid: "s1", event: { kind: "command", command: "pnpm typecheck", exit_code: 1 } }]);
    await b.ingestObservationsFromDisk("ws", f);
    const ev = await b.listKnowledgeEvidence("ws", atom.id);
    const cond = ev.find((e) => e.event_type === "condition_observed");
    expect(cond).toBeTruthy();
    expect(cond!.evidence_kind).toBe("command_failed");
  });

  it("condition-not-observed produces no failure evidence (absence is not failure)", async () => {
    const b = make();
    const atom = await deliveredRemedy(b, "s1", "/apps/web", ["fixIt()"], { condition: ["pnpm typecheck"] });
    const f = ledger(scratch(), [{ sid: "s1", event: { kind: "command", command: "pnpm typecheck", exit_code: 0 } }]);
    await b.ingestObservationsFromDisk("ws", f);
    const ev = await b.listKnowledgeEvidence("ws", atom.id);
    expect(ev.find((e) => e.event_type === "outcome_failure")).toBeFalsy();
    expect(ev.find((e) => e.event_type === "condition_observed")).toBeFalsy();
  });

  it("error persistence: same error after an attributed edit is STRONG failure evidence", async () => {
    const b = make();
    const atom = await deliveredRemedy(b, "s1", "/apps/web", ["addType()"], { condition: ["Cannot find name 'foo'"] });
    // edit is attributed; the condition error appears; then the same error persists in a later run.
    const f = ledger(scratch(), [
      { sid: "s1", event: { kind: "edit", path: "/apps/web/x.ts", before: "raw", after: "addType()" } },
      { sid: "s1", event: { kind: "command", command: "pnpm typecheck", exit_code: 1, output: "x.ts:1:1 - Error: Cannot find name 'foo'" } },
      { sid: "s1", event: { kind: "command", command: "pnpm typecheck", exit_code: 1, output: "x.ts:2:2 - Error: Cannot find name 'foo'" } },
    ]);
    await b.ingestObservationsFromDisk("ws", f);
    const agg = await b.aggregateAtomEvidence("ws", atom.id);
    expect(agg.attributed).toBe(1);
    expect(agg.outcome_failure).toBeGreaterThanOrEqual(1);
  });
});

describe("V30 debug trace + restart", () => {
  it("explainAtomEvidence returns the ordered delivery -> event -> attribution chain with reason codes", async () => {
    const b = make();
    const atom = await deliveredRemedy(b, "s1", "/apps/web", ["safeFoo()"]);
    const f = ledger(scratch(), [{ sid: "s1", event: { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" }, check: { was_failing: true, now_passing: true } }]);
    await b.ingestObservationsFromDisk("ws", f);
    const trace = await b.explainAtomEvidence("ws", "s1", atom.id);
    expect(trace.delivery_id).toBe(`s1:${atom.id}`);
    expect(trace.delivered).toBe(1);
    const used = trace.chain.find((c) => c.event_type === "usage_attributed");
    expect(used?.reason).toBe("literal_inserted");
    expect(trace.chain.some((c) => c.event_type === "outcome_success" && c.strength === "STRONG")).toBe(true);
  });

  it("RESTART: evidence survives a close/reopen and later events continue coherently", async () => {
    const dir = scratch();
    const dbPath = join(dir, "pathrule.db");
    const b1 = make(dbPath);
    const atom = await deliveredRemedy(b1, "s1", "/apps/web", ["safeFoo()"]);
    const atomId = atom.id;
    const f1 = ledger(dir, [{ sid: "s1", event: { kind: "edit", path: "/apps/web/x.ts", before: "foo()", after: "safeFoo()" } }]);
    await b1.ingestObservationsFromDisk("ws", f1);
    expect((await b1.aggregateAtomEvidence("ws", atomId)).attributed).toBe(1);
    b1.close();

    // Reopen the same DB file: prior evidence is intact and a new event appends coherently.
    const b2 = new LocalBackend(dbPath, { genId: () => "x", now: () => "2026-09-10T00:00:05.000Z" });
    expect((await b2.aggregateAtomEvidence("ws", atomId)).attributed).toBe(1);
    const f2 = join(dir, "obs2.jsonl");
    writeFileSync(f2, JSON.stringify({ sid: "s1", at: "t", event: { kind: "command", command: "pnpm test", exit_code: 0 } }) + "\n");
    // s1 delivery persisted, so a command remedy would need its own delivery; here we just prove the
    // drain runs post-restart without error and does not corrupt existing evidence.
    await b2.ingestObservationsFromDisk("ws", f2);
    expect((await b2.aggregateAtomEvidence("ws", atomId)).attributed).toBe(1);
    b2.close();
  });
});
