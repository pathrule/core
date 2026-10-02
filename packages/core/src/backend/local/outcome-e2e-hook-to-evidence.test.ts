// SPDX-License-Identifier: Apache-2.0
/**
 * V30 crown proof: the WHOLE live chain in one flow, with no hand-built ObservedEvent.
 *
 *   real pathrule-hook.js process (a real Claude PostToolUse payload)
 *     -> knowledge-observations.jsonl   (the hook writes it)
 *       -> LocalBackend.ingestObservationsFromDisk   (the production drain)
 *         -> attributeUsage engine
 *           -> knowledge_evidence row   (categorical, content-free)
 *
 * The backend DB and the hook's cache share one temp PATHRULE_HOME, so this is the exact path a
 * running install takes. The only thing not exercised is a live model ORIGINATING the tool call,
 * which is an environment/credentials concern, not a code-path one.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalBackend } from "./local-backend.js";
import { type RemedyInput } from "@pathrule/shared/knowledge/remedy.js";
import { stampProposedRemedy } from "@pathrule/shared/knowledge/remedy-fingerprint.js";

const HOOK_SRC = join(dirname(fileURLToPath(import.meta.url)), "../../../../shared/src/hook-supervisor/pathrule-hook.js");
const cleanup: string[] = [];
afterAll(() => { for (const d of cleanup) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });

// The hook runs as a copied file, not an import, so it is outside the open-source core closure
// and the public mirror has no hook to run. The monorepo still runs this end to end.
describe.skipIf(!existsSync(HOOK_SRC))("V30 end to end: real hook process to persisted evidence", () => {
  it("a real agent Edit flows through the hook and the drain into ATTRIBUTED evidence", async () => {
    const home = mkdtempSync(join(tmpdir(), "pr-e2e-home-"));
    const repo = mkdtempSync(join(tmpdir(), "pr-e2e-repo-"));
    const binDir = mkdtempSync(join(tmpdir(), "pr-e2e-bin-"));
    cleanup.push(home, repo, binDir);
    const wsId = "wsE2E";
    const env = { ...process.env, PATHRULE_HOME: home };

    // 1) Real LocalBackend on this PATHRULE_HOME: approve a remedy and record its delivery to s1.
    const backend = LocalBackend.openForWorkspace(wsId, env);
    backend.registerWorkspace({ workspaceId: wsId, localRootPath: repo });
    const node = await backend.ensureNodeForPath(wsId, "/apps/web", "folder");
    await backend.writeMemory({ workspaceId: wsId, nodeId: node.id, title: "t", content: "wrap with safeFoo() to fix it" });
    const memRow = (backend as unknown as { db: { prepare(s: string): { get(...a: unknown[]): unknown } } }).db.prepare("SELECT id FROM memories ORDER BY rowid DESC LIMIT 1").get() as { id: string };
    const input: RemedyInput = {
      variant: "trouble", condition_evidence: ["it broke"], condition_normalized: null,
      action_evidence: ["safeFoo()"], evidence_state: "OBSERVED_SUCCESS",
      source: { kind: "memory", id: memRow.id, title: "t", node_path: null }, observed_at: "2026-09-01T00:00:00.000Z",
    };
    const atom = await backend.proposeRemedyAtom(wsId, stampProposedRemedy(input, { now: "2026-09-01T00:00:00.000Z" }));
    await backend.decideRemedyAtom(wsId, atom.id, "approve", "user-1");
    await backend.recordRemedyDelivery({ workspaceId: wsId, atomId: atom.id, sessionId: "s1", path: "/apps/web" });

    // 2) Stand up the hook's cache: index + session with a delivered advisory.
    const cacheWs = join(home, "cache", wsId);
    mkdirSync(cacheWs, { recursive: true });
    writeFileSync(join(cacheWs, "hook-index.json"), JSON.stringify({ workspace_id: wsId, workspace_root: repo, generated_at: "2026-09-10T00:00:00.000Z" }));
    writeFileSync(join(cacheWs, "session-s1.json"), JSON.stringify({ session_id: "s1", delivered_advisory_refs: [atom.id] }));

    // 3) Run the REAL hook binary on a real Claude PostToolUse Edit event.
    const hookCjs = join(binDir, "pathrule-hook.cjs");
    copyFileSync(HOOK_SRC, hookCjs);
    execFileSync("node", [hookCjs], {
      input: JSON.stringify({
        hook_event_name: "PostToolUse", tool_name: "Edit", session_id: "s1", cwd: repo,
        tool_input: { file_path: join(repo, "apps/web/button.tsx"), old_string: "const x = foo();", new_string: "const x = safeFoo();" },
        tool_response: {},
      }),
      env, cwd: repo, encoding: "utf8", timeout: 15000,
    });

    // 4) Drain the file the hook just wrote through the production backend seam.
    const res = await backend.ingestObservationsFromDisk(wsId, join(cacheWs, "knowledge-observations.jsonl"));
    expect(res.observed).toBe(1);

    // 5) The remedy now has exactly one ATTRIBUTED usage, produced with no manual event and no model.
    const agg = await backend.aggregateAtomEvidence(wsId, atom.id);
    expect(agg.attributed).toBe(1);
    const trace = await backend.explainAtomEvidence(wsId, "s1", atom.id);
    expect(trace.chain.find((c) => c.event_type === "usage_attributed")?.reason).toBe("literal_inserted");
    backend.close();
  });
});
