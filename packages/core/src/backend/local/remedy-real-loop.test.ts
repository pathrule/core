// SPDX-License-Identifier: Apache-2.0
/**
 * The real loop, end to end, with nothing faked:
 *
 *   real workspace memory -> local model -> grounding -> validator -> persisted atom
 *   -> reload -> approve -> reload
 *
 * Everything else in this repository tests a piece of that with a stub. This tests the whole
 * thing against the actual database on this machine and an actual local model, which is the only
 * way to find out whether the frozen representation survives contact with production.
 *
 * It writes to a COPY of the workspace database, so an experiment can never touch real knowledge.
 * It skips, rather than fails, when either the database or the model is absent: a contributor's
 * checkout has neither.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { analyzeMemoryForRemedy } from "@pathrule/shared/local-intelligence/analyze-memory.js";
import { LocalIntelligenceClient } from "@pathrule/shared/local-intelligence/client.js";

import { LocalBackend } from "./local-backend.js";

const WS = "467b0e6e-dec5-46a6-bd5e-4294a82603d6";
const REAL_DB = join(homedir(), ".pathrule", WS, "pathrule.db");
const BASE_URL = process.env["PATHRULE_LOCAL_INTELLIGENCE_URL"] ?? "http://127.0.0.1:8081";

const tmp = mkdtempSync(join(tmpdir(), "pathrule-real-loop-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function modelIsUp(): Promise<boolean> {
  try {
    const client = new LocalIntelligenceClient({ baseUrl: BASE_URL, timeoutMs: 20_000 });
    return (await client.health()).ok;
  } catch {
    return false;
  }
}

const dbPresent = existsSync(REAL_DB);
const modelUp = dbPresent ? await modelIsUp() : false;

describe.skipIf(!dbPresent || !modelUp)("REMEDY, real knowledge through the real model", () => {
  it("proposes from real memories, persists, and survives approve across two reloads", async () => {
    const dbPath = join(tmp, "workspace.db");
    copyFileSync(REAL_DB, dbPath);

    const client = new LocalIntelligenceClient({ baseUrl: BASE_URL, timeoutMs: 120_000 });
    const health = await client.health();
    expect(health.ok).toBe(true);

    const backend = new LocalBackend(dbPath);
    const memories = await backend.listMemories({ workspaceId: WS });
    expect(memories.length).toBeGreaterThan(50);

    // Real knowledge, newest first, with no filtering on what the answer might be. The loop keeps
    // going until a legitimate source yields one: "this memory has no remedy" is a valid answer,
    // so a single source proving nothing would prove nothing.
    const candidates = [...memories]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 12);

    let proposedId: string | null = null;
    let sourceId: string | null = null;
    const seen: string[] = [];
    for (const m of candidates) {
      const out = await analyzeMemoryForRemedy(backend, client, m.id, new Date().toISOString());
      seen.push(`${out.status} ${m.title.slice(0, 50)}`);
      // A failure must never be silently treated as "found nothing": that is the whole point of
      // the boundary, so the test asserts it rather than tolerating it.
      expect(out.status).not.toBe("failed");
      if (out.status === "proposed") {
        expect(out.atom.status).toBe("proposed");
        expect(out.atom.authority).toBe("inferred");
        expect(out.atom.action_evidence.length).toBeGreaterThan(0);
        proposedId = out.atom.id;
        sourceId = out.atom.source.id;
        break;
      }
    }
    // eslint-disable-next-line no-console -- the analysed sources are the evidence for this run
    console.log(`analysed ${seen.length} real memories:\n  ${seen.join("\n  ")}`);
    expect(proposedId, `no remedy proposed from ${seen.length} real memories`).toBeTruthy();

    // The evidence must be literally present in the memory it came from.
    const source = await backend.readMemory(sourceId!);
    expect(source).not.toBeNull();
    const pendingBefore = await backend.listProposedRemedyAtoms(WS);
    const atom = pendingBefore.find((a) => a.id === proposedId)!;
    expect(atom).toBeTruthy();
    const haystack = `${source!.title}\n${source!.content}`;
    for (const span of atom.action_evidence) expect(haystack).toContain(span);
    for (const span of atom.condition_evidence) expect(haystack).toContain(span);
    backend.close?.();

    // Reload: a new connection, the same knowledge.
    const reopened = new LocalBackend(dbPath);
    const afterReload = (await reopened.listProposedRemedyAtoms(WS)).find((a) => a.id === proposedId);
    expect(afterReload).toBeTruthy();
    expect(afterReload!.action_evidence).toEqual(atom.action_evidence);
    expect(afterReload!.source).toEqual(atom.source);
    expect(afterReload!.evidence_state).toBe(atom.evidence_state);

    // Approve, then reload again.
    await reopened.decideRemedyAtom(WS, proposedId!, "approve", "sertan");
    reopened.close?.();

    const third = new LocalBackend(dbPath);
    const decided = (await third.listRemedyAtomsForSubject("memory", sourceId!)).find((a) => a.id === proposedId);
    expect(decided).toMatchObject({ status: "active", authority: "human", approved_by: "sertan" });
    expect((await third.listProposedRemedyAtoms(WS)).some((a) => a.id === proposedId)).toBe(false);
    third.close?.();
  }, 600_000);

  it("re-analysing a rejected memory does not bring the proposal back", async () => {
    const dbPath = join(tmp, "reject.db");
    copyFileSync(REAL_DB, dbPath);
    const client = new LocalIntelligenceClient({ baseUrl: BASE_URL, timeoutMs: 120_000 });
    const backend = new LocalBackend(dbPath);

    const memories = await backend.listMemories({ workspaceId: WS });
    const candidates = [...memories]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, 12);

    let atomId: string | null = null;
    let memId: string | null = null;
    for (const m of candidates) {
      const out = await analyzeMemoryForRemedy(backend, client, m.id, new Date().toISOString());
      if (out.status === "proposed") { atomId = out.atom.id; memId = m.id; break; }
    }
    expect(atomId, "no remedy proposed to reject").toBeTruthy();

    await backend.decideRemedyAtom(WS, atomId!, "reject", "sertan");
    expect((await backend.listProposedRemedyAtoms(WS)).length).toBe(0);

    // The same memory, analysed again. The short circuit means no inference even happens, and
    // the fingerprint would stop it at the store even if it did.
    const again = await analyzeMemoryForRemedy(backend, client, memId!, new Date().toISOString());
    expect(again.status).toBe("already_decided");
    expect((await backend.listProposedRemedyAtoms(WS)).length).toBe(0);
    backend.close?.();
  }, 600_000);
});
