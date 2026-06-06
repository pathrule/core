// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LocalBackend } from "./local-backend.js";
import { runKnowledgeBackendContract, CONTRACT_TEST_EMBED } from "../contract-suite.js";

// Same contract suite as the in-memory reference, now over real SQLite (:memory:).
// Green here = LocalBackend and the reference behave identically (parity).
// The deterministic embed seam enables the semantic-candidates parity block.
runKnowledgeBackendContract("LocalBackend (sqlite :memory:)", () => {
  let counter = 0;
  return new LocalBackend(":memory:", {
    genId: () => `id-${++counter}`,
    now: () => "2026-06-04T00:00:00.000Z",
    embed: CONTRACT_TEST_EMBED,
  });
});

// resolveWorkspaceFromCwd over the local `workspaces` rows
// (registerWorkspace is the OSS-init seam; not on the cross-edition interface).
describe("LocalBackend workspace resolution", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps) rmSync(d, { recursive: true, force: true });
    tmps.length = 0;
  });

  it("maps a cwd under a registered root to a relative path; null when uncovered", async () => {
    const b = new LocalBackend(":memory:");
    b.registerWorkspace({ workspaceId: "ws-1", localRootPath: "/Users/me/repo" });
    expect(await b.resolveWorkspaceFromCwd("/Users/me/repo/src/api")).toEqual({
      workspaceId: "ws-1",
      localRootPath: "/Users/me/repo",
      relativePath: "/src/api",
    });
    expect((await b.resolveWorkspaceFromCwd("/Users/me/repo"))?.relativePath).toBe(""); // cwd === root
    expect(await b.resolveWorkspaceFromCwd("/Users/other/elsewhere")).toBeNull();
  });

  it("picks the LONGEST matching root (nested package wins over monorepo root)", async () => {
    const b = new LocalBackend(":memory:");
    b.registerWorkspace({ workspaceId: "root", localRootPath: "/repo" });
    b.registerWorkspace({ workspaceId: "nested", localRootPath: "/repo/packages/api" });
    const m = await b.resolveWorkspaceFromCwd("/repo/packages/api/src");
    expect(m?.workspaceId).toBe("nested");
    expect(m?.relativePath).toBe("/src");
  });

  it("canonicalizes symlinked roots so init (one form) and resolve (another) agree", async () => {
    // Real symlinked dirs: register via the symlink path, resolve via a path under it.
    // Without realpath canonicalization the two forms wouldn't prefix-match.
    const realRoot = mkdtempSync(join(tmpdir(), "pathrule-real-"));
    const linkRoot = mkdtempSync(join(tmpdir(), "pathrule-link-")) + "/ws";
    tmps.push(realRoot, dirname(linkRoot));
    symlinkSync(realRoot, linkRoot);
    mkdirSync(join(realRoot, "src"));

    const b = new LocalBackend(":memory:");
    // init stores the symlinked form; resolve passes a path under the symlink too.
    b.registerWorkspace({ workspaceId: "ws-sym", localRootPath: linkRoot });
    const viaLink = await b.resolveWorkspaceFromCwd(join(linkRoot, "src"));
    expect(viaLink?.workspaceId).toBe("ws-sym");
    expect(viaLink?.relativePath).toBe("/src");
    // And resolving via the REAL (post-symlink) form also matches the same workspace.
    const viaReal = await b.resolveWorkspaceFromCwd(join(realRoot, "src"));
    expect(viaReal?.workspaceId).toBe("ws-sym");
    expect(viaReal?.relativePath).toBe("/src");
  });
});
