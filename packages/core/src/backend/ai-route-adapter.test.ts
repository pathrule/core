// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { RouteIntentInput } from "@pathrule/shared/routing-types.js";
import {
  runAiRouteAdapter,
  extractJsonObject,
  validateRoutingDecision,
  hasAiRouteKey,
} from "./ai-route-adapter.js";

const INPUT: RouteIntentInput = {
  workspaceId: "ws-1",
  userIntent: "fix the login redirect bug",
  workspaceOverview: [],
  recentActivities: [],
};

/** Build a fetch stub that returns the given assistant text(s) on each call. */
function fetchReturning(...texts: string[]): typeof fetch {
  let call = 0;
  return (async () => {
    const text = texts[Math.min(call, texts.length - 1)];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text }] }),
    };
  }) as unknown as typeof fetch;
}

describe("ai-route-adapter", () => {
  describe("runAiRouteAdapter", () => {
    it("returns null when no key is configured (capability unwired)", async () => {
      // No PATHRULE_AI_ROUTE_KEY in the test env and none injected.
      expect(process.env.PATHRULE_AI_ROUTE_KEY).toBeFalsy();
      expect(await runAiRouteAdapter(INPUT)).toBeNull();
    });

    it("returns a decision when the provider replies with valid JSON", async () => {
      const decision = {
        next: "edit_known_path",
        reason: "login redirect handler is known",
        confidence: "high",
        task_shape: "bug_fix",
        context_depth: "focused",
        primary_files: ["src/auth/redirect.ts"],
      };
      const res = await runAiRouteAdapter(INPUT, {
        apiKey: "test-key",
        fetchImpl: fetchReturning(JSON.stringify(decision)),
      });
      expect(res?.decision?.next).toBe("edit_known_path");
      expect(res?.decision?.confidence).toBe("high");
      expect(res?.decision?.primary_files).toEqual(["src/auth/redirect.ts"]);
      expect(typeof res?.latency_ms).toBe("number");
      expect(res?.fallback).toBeUndefined();
    });

    it("tolerates code fences / prose around the JSON", async () => {
      const reply =
        'Here is my decision:\n```json\n{"next":"answer_directly","confidence":"low","reason":"q"}\n```';
      const res = await runAiRouteAdapter(INPUT, { apiKey: "k", fetchImpl: fetchReturning(reply) });
      expect(res?.decision?.next).toBe("answer_directly");
    });

    it("retries once on invalid JSON, then succeeds", async () => {
      const res = await runAiRouteAdapter(INPUT, {
        apiKey: "k",
        fetchImpl: fetchReturning(
          "not json at all",
          '{"next":"no_action","confidence":"low","reason":"none"}',
        ),
      });
      expect(res?.decision?.next).toBe("no_action");
      expect(res?.fallback).toBeUndefined();
    });

    it("falls back to parse_failure when both attempts are invalid", async () => {
      const res = await runAiRouteAdapter(INPUT, {
        apiKey: "k",
        fetchImpl: fetchReturning("garbage", "still garbage"),
      });
      expect(res?.decision).toBeUndefined();
      expect(res?.fallback).toBe("parse_failure");
    });

    it("falls back to edge_error when the provider call throws", async () => {
      const throwing = (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;
      const res = await runAiRouteAdapter(INPUT, { apiKey: "k", fetchImpl: throwing });
      expect(res?.fallback).toBe("edge_error");
    });

    it("falls back to edge_timeout on an aborted call", async () => {
      const aborting = (async () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      }) as unknown as typeof fetch;
      const res = await runAiRouteAdapter(INPUT, { apiKey: "k", fetchImpl: aborting });
      expect(res?.fallback).toBe("edge_timeout");
    });
  });

  describe("validateRoutingDecision", () => {
    it("rejects missing/invalid next or confidence", () => {
      expect(validateRoutingDecision({ confidence: "high" })).toBeNull();
      expect(validateRoutingDecision({ next: "bogus", confidence: "high" })).toBeNull();
      expect(validateRoutingDecision({ next: "no_action", confidence: "maybe" })).toBeNull();
    });

    it("keeps valid optionals and drops invalid ones", () => {
      const d = validateRoutingDecision({
        next: "read_memory",
        confidence: "high",
        reason: "x",
        memory_id: "not-a-uuid",
        task_shape: "bug_fix",
        context_depth: "weird",
        include: ["hot_paths", "bogus_section"],
        primary_files: ["a.ts", 42],
      });
      expect(d?.next).toBe("read_memory");
      expect(d?.memory_id).toBeUndefined(); // invalid uuid dropped
      expect(d?.task_shape).toBe("bug_fix");
      expect(d?.context_depth).toBeUndefined(); // invalid enum dropped
      expect(d?.include).toEqual(["hot_paths"]); // bogus section filtered
      expect(d?.primary_files).toEqual(["a.ts"]); // non-string filtered
    });
  });

  describe("extractJsonObject", () => {
    it("extracts the first balanced object from surrounding noise", () => {
      expect(extractJsonObject('prefix {"a":1} suffix')).toEqual({ a: 1 });
      expect(extractJsonObject("no object here")).toBeNull();
    });
  });

  describe("hasAiRouteKey", () => {
    it("is false without the env key", () => {
      expect(hasAiRouteKey()).toBe(false);
    });
  });
});
