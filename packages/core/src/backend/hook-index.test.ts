// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { assembleHookIndex, type HookIndexInput } from "./hook-index.js";

function baseInput(overrides?: Partial<HookIndexInput>): HookIndexInput {
  return {
    workspaceId: "ws-1",
    generatedAt: "2026-06-10T00:00:00.000Z",
    memories: [],
    rules: [],
    skills: [],
    recentActivitySubjects: [],
    recentActivityDigest: [],
    workEpisodes: [],
    pendingRefreshCount: 0,
    inProgressRefreshCount: 0,
    ...overrides,
  };
}

describe("assembleHookIndex content_hash (delta primitive)", () => {
  it("stamps content_hash on memory, rule, and skill stubs", () => {
    const index = assembleHookIndex(
      baseInput({
        memories: [
          { id: "m1", title: "Encapsulation", content: "Plugins create a new context.", node_path: "/lib" },
        ],
        rules: [
          {
            id: "r1",
            name: "No raw hex",
            content: "Use design tokens, never raw hex.",
            scope_type: "folder",
            priority: "high",
            node_paths: ["/packages/ui"],
          },
        ],
        skills: [
          { id: "s1", name: "add-plugin", description: null, content: "Step 1...", source: "manual", github_url: null },
        ],
      }),
    );

    const mem = index.path_memories["/lib"]?.[0];
    const rule = index.path_rules["/packages/ui"]?.[0];
    const skill = index.skill_invocation_index?.["add-plugin"]?.[0];

    expect(mem?.content_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(rule?.content_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(skill?.content_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable for identical content and changes when content changes", () => {
    const make = (content: string) =>
      assembleHookIndex(
        baseInput({
          memories: [{ id: "m1", title: "T", content, node_path: "/lib" }],
        }),
      ).path_memories["/lib"]![0]!.content_hash;

    const a = make("original body");
    const b = make("original body");
    const c = make("edited body");

    expect(a).toBe(b); // unchanged content ⇒ same hash ⇒ no re-injection
    expect(a).not.toBe(c); // edited content ⇒ new hash ⇒ delta re-injects
  });
});

describe("assembleHookIndex hot_paths (routing signal)", () => {
  it("derives top hot paths from recent activity", () => {
    const index = assembleHookIndex(
      baseInput({
        recentActivityDigest: [
          { domain: "backend", action: "update", node_path: "/lib", task_summary: "x" },
          { domain: "backend", action: "fix", node_path: "/lib", task_summary: "y" },
          { domain: "ui", action: "update", node_path: "/web", task_summary: "z" },
          { domain: "docs", action: "update", node_path: "/", task_summary: "root ignored" },
        ],
      }),
    );
    expect(index.hot_paths).toEqual([
      { path: "/lib", count: 2 },
      { path: "/web", count: 1 },
    ]);
  });
});
