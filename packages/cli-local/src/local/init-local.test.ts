// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "@pathrule/core";
import { initLocalWorkspace } from "./init-local.js";

describe("initLocalWorkspace (M52 5.1)", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps) rmSync(d, { recursive: true, force: true });
    tmps.length = 0;
  });

  function freshHome(): NodeJS.ProcessEnv {
    const home = mkdtempSync(join(tmpdir(), "pathrule-cli-home-"));
    tmps.push(home);
    return { PATHRULE_HOME: home } as NodeJS.ProcessEnv;
  }

  it("creates a local workspace bound to the cwd and makes it discoverable", async () => {
    const env = freshHome();
    const result = await initLocalWorkspace({
      cwd: "/Users/me/projects/acme",
      env,
      genWorkspaceId: () => "ws-fixed",
    });
    expect(result).toEqual({
      workspaceId: "ws-fixed",
      name: "acme", // defaults to the folder name
      localRootPath: "/Users/me/projects/acme",
      action: "created",
    });
    // The store is now discoverable for the cwd (and subpaths).
    expect(
      LocalBackend.discoverWorkspaceForCwd("/Users/me/projects/acme/src", env)?.workspaceId,
    ).toBe("ws-fixed");
  });

  it("is idempotent — a folder already inside a local workspace reuses it", async () => {
    const env = freshHome();
    const first = await initLocalWorkspace({ cwd: "/repo", env, genWorkspaceId: () => "ws-1" });
    expect(first.action).toBe("created");

    // A subfolder of an existing local workspace must NOT create a second store.
    const second = await initLocalWorkspace({
      cwd: "/repo/packages/api",
      env,
      genWorkspaceId: () => "ws-2-should-not-be-used",
    });
    expect(second.action).toBe("exists");
    expect(second.workspaceId).toBe("ws-1");
    expect(second.localRootPath).toBe("/repo");
  });

  it("honors an explicit workspace name", async () => {
    const env = freshHome();
    const result = await initLocalWorkspace({
      cwd: "/tmp/x",
      name: "My Site",
      env,
      genWorkspaceId: () => "w",
    });
    expect(result.name).toBe("My Site");
  });
});
