// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { NodeBrief } from "@pathrule/shared/intelligence/types.js";
import type { KnowledgeBackend } from "./knowledge-backend.js";
import type { EmbedFn } from "./embedding-adapter.js";

/**
 * Deterministic embedding stub for the parity suite. Maps text to a 3-dim
 * "topic" vector by counting occurrences of alpha/beta/gamma — so a query
 * cosine-matches a memory iff they share a topic. Non-topic text → the zero
 * vector (cosine 0, never surfaces). This exercises the embed→cosine→shape
 * plumbing deterministically without a real provider (retrieval QUALITY is not
 * testable offline).
 */
export const CONTRACT_TEST_EMBED: EmbedFn = (text) => {
  const lower = text.toLowerCase();
  const vec = ["alpha", "beta", "gamma"].map((t) => lower.split(t).length - 1);
  return Promise.resolve({
    embedding: vec.every((v) => v === 0) ? [0, 0, 0] : vec,
    model: "test-embed",
    dims: 3,
  });
};

/**
 * Reusable KnowledgeBackend contract suite. Runs the same assertions against any
 * backend factory — the in-memory reference and the SQLite-backed backend. If two
 * backends diverge, this fails.
 */
export function runKnowledgeBackendContract(
  label: string,
  makeBackend: () => KnowledgeBackend,
): void {
  const WS = "ws-1";

  describe(`KnowledgeBackend contract — ${label}`, () => {
    describe("memory", () => {
      it("write → read → list → update → delete round-trips", async () => {
        const b = makeBackend();
        const created = await b.writeMemory({
          workspaceId: WS,
          nodeId: "n1",
          title: "T",
          content: "C",
        });
        expect(created.title).toBe("T");
        expect(created.source).toBe("claude");
        expect(created.versionNumber).toBe(1);

        expect(await b.readMemory(created.id)).toEqual(created);
        expect(await b.listMemories({ workspaceId: WS })).toHaveLength(1);

        const updated = await b.updateMemory({ id: created.id, content: "C2" });
        expect(updated.content).toBe("C2");
        expect(updated.versionNumber).toBe(2);

        const del = await b.deleteMemory({ id: created.id });
        expect(del.status).toBe("deleted");
        expect(await b.readMemory(created.id)).toBeNull();
        expect(await b.listMemories({ workspaceId: WS })).toHaveLength(0);
      });

      it("soft delete archives and restoreMemory brings it back; restore on a live row is rejected", async () => {
        const b = makeBackend();
        const m = await b.writeMemory({ workspaceId: WS, title: "t", content: "c" });
        // restoring a live (not-deleted) memory is rejected
        expect((await b.restoreMemory(m.id)).status).toBe("rejected");
        await b.deleteMemory({ id: m.id }); // soft delete
        expect(await b.readMemory(m.id)).toBeNull();
        expect(await b.listMemories({ workspaceId: WS })).toHaveLength(0);
        expect(await b.listMemories({ workspaceId: WS, status: "archived" })).toHaveLength(1);
        const restored = await b.restoreMemory(m.id);
        expect(restored.status).toBe("restored");
        expect(await b.readMemory(m.id)).not.toBeNull();
        expect(await b.listMemories({ workspaceId: WS })).toHaveLength(1);
        // restoring an unknown id is rejected
        expect((await b.restoreMemory("nope")).status).toBe("rejected");
      });

      it("deleteMemory reports conflict on a stale version and rejects an unknown id", async () => {
        const b = makeBackend();
        const m = await b.writeMemory({ workspaceId: WS, title: "t", content: "c" });
        const stale = await b.deleteMemory({ id: m.id, expectedVersionId: "wrong-token" });
        expect(stale.status).toBe("conflict");
        expect(await b.readMemory(m.id)).not.toBeNull(); // still there — not deleted
        expect((await b.deleteMemory({ id: "nope" })).status).toBe("rejected");
      });

      it("scopes lists by workspace", async () => {
        const b = makeBackend();
        await b.writeMemory({ workspaceId: WS, title: "a", content: "x" });
        await b.writeMemory({ workspaceId: "ws-2", title: "b", content: "y" });
        expect(await b.listMemories({ workspaceId: WS })).toHaveLength(1);
      });
    });

    describe("rule + skill", () => {
      it("rule round-trips, attaches to its node, and deletes", async () => {
        const b = makeBackend();
        const node = await b.ensureNodeForPath(WS, "/api");
        const r = await b.writeRule({
          workspaceId: WS,
          nodeId: node.id,
          name: "no-x",
          content: "do not x",
          scopeType: "project",
        });
        expect(r.priority).toBe("medium");
        expect((await b.listRules({ workspaceId: WS }))[0]?.id).toBe(r.id);
        expect((await b.getNodeForRule(r.id))?.relativePath).toBe("/api"); // attached via node_rules
        const del = await b.deleteRule({ id: r.id });
        expect(del.status).toBe("deleted");
        expect(await b.readRule(r.id)).toBeNull();
      });

      it("rule write without a node stays unattached", async () => {
        const b = makeBackend();
        const r = await b.writeRule({
          workspaceId: WS,
          name: "free",
          content: "x",
          scopeType: "project",
        });
        expect(await b.getNodeForRule(r.id)).toBeNull();
      });

      it("skill round-trips, attaches to its node, and deletes", async () => {
        const b = makeBackend();
        const node = await b.ensureNodeForPath(WS, "/ops");
        const s = await b.writeSkill({
          workspaceId: WS,
          nodeId: node.id,
          name: "deploy",
          content: "steps",
        });
        expect(s.source).toBe("manual");
        expect(s.tags).toEqual([]);
        expect(await b.readSkill(s.id)).toEqual(s);
        expect((await b.getNodeForSkill(s.id))?.relativePath).toBe("/ops"); // attached via node_skills
        const del = await b.deleteSkill({ id: s.id });
        expect(del.status).toBe("deleted");
        expect(await b.readSkill(s.id)).toBeNull();
      });

      it("soft-deleted rule and skill restore back to active", async () => {
        const b = makeBackend();
        const r = await b.writeRule({
          workspaceId: WS,
          name: "r",
          content: "c",
          scopeType: "project",
        });
        await b.deleteRule({ id: r.id });
        expect(await b.readRule(r.id)).toBeNull();
        expect((await b.restoreRule(r.id)).status).toBe("restored");
        expect(await b.readRule(r.id)).not.toBeNull();

        const s = await b.writeSkill({ workspaceId: WS, name: "s", content: "c" });
        await b.deleteSkill({ id: s.id });
        expect(await b.readSkill(s.id)).toBeNull();
        expect((await b.restoreSkill(s.id)).status).toBe("restored");
        expect(await b.readSkill(s.id)).not.toBeNull();
      });

      it("updateSkill clears description with null but keeps it when undefined", async () => {
        const b = makeBackend();
        const s = await b.writeSkill({
          workspaceId: WS,
          name: "x",
          content: "c",
          description: "keep",
        });
        const kept = await b.updateSkill({ id: s.id, content: "c2" });
        expect(kept.description).toBe("keep");
        const cleared = await b.updateSkill({ id: s.id, description: null });
        expect(cleared.description).toBeNull();
      });
    });

    describe("tree", () => {
      it("getTree is empty and getNode returns null for an unknown id", async () => {
        const b = makeBackend();
        expect(await b.getTree(WS)).toEqual([]);
        expect(await b.getNode("does-not-exist")).toBeNull();
      });

      it("getNodeDetail returns the node with its attached memory/rule/skill ids", async () => {
        const b = makeBackend();
        const node = await b.ensureNodeForPath(WS, "/svc");
        const m = await b.writeMemory({
          workspaceId: WS,
          nodeId: node.id,
          title: "m",
          content: "c",
        });
        const r = await b.writeRule({
          workspaceId: WS,
          nodeId: node.id,
          name: "r",
          content: "c",
          scopeType: "project",
        });
        const s = await b.writeSkill({ workspaceId: WS, nodeId: node.id, name: "s", content: "c" });
        const detail = await b.getNodeDetail(node.id);
        expect(detail?.relativePath).toBe("/svc");
        expect(detail?.memoryIds).toEqual([m.id]);
        expect(detail?.ruleIds).toEqual([r.id]);
        expect(detail?.skillIds).toEqual([s.id]);
        // archived content drops out of the attachment lists
        await b.deleteMemory({ id: m.id });
        expect((await b.getNodeDetail(node.id))?.memoryIds).toEqual([]);
        expect(await b.getNodeDetail("does-not-exist")).toBeNull();
      });

      it("workspaceOverview groups attached content by node, sorts by path, honors exclude", async () => {
        const b = makeBackend();
        const apiNode = await b.ensureNodeForPath(WS, "/api");
        const webNode = await b.ensureNodeForPath(WS, "/web");
        await b.writeMemory({
          workspaceId: WS,
          nodeId: apiNode.id,
          title: "API memory",
          content: "c",
        });
        await b.writeRule({
          workspaceId: WS,
          nodeId: webNode.id,
          name: "web rule",
          content: "c",
          scopeType: "folder",
        });
        // a node with no attached content is omitted
        await b.ensureNodeForPath(WS, "/empty");

        const overview = await b.workspaceOverview(WS);
        expect(overview.map((n) => n.relative_path)).toEqual(["/api", "/web"]); // sorted, empty dropped
        expect(overview[0]?.memories[0]?.title).toBe("API memory");
        expect(Array.isArray(overview[0]?.memories[0]?.semantic_tags)).toBe(true); // tags inferred
        expect(overview[1]?.rules[0]?.name).toBe("web rule");

        const excluded = await b.workspaceOverview(WS, apiNode.id);
        expect(excluded.map((n) => n.relative_path)).toEqual(["/web"]);
      });

      it("findNodeByPath + getNodeContent return the node and its bodied content", async () => {
        const b = makeBackend();
        const node = await b.ensureNodeForPath(WS, "/svc");
        await b.writeMemory({
          workspaceId: WS,
          nodeId: node.id,
          title: "Mem",
          content: "body text",
        });
        await b.writeRule({
          workspaceId: WS,
          nodeId: node.id,
          name: "Rule",
          content: "do x",
          scopeType: "folder",
        });
        await b.writeSkill({ workspaceId: WS, nodeId: node.id, name: "Sk", content: "steps" });

        const ref = await b.findNodeByPath(WS, "/svc");
        expect(ref?.id).toBe(node.id);
        expect(ref?.relativePath).toBe("/svc");
        expect(await b.findNodeByPath(WS, "/nope")).toBeNull();

        const content = await b.getNodeContent(node.id);
        expect(content.memories[0]).toMatchObject({ title: "Mem", content: "body text" });
        expect(content.rules[0]).toMatchObject({ name: "Rule", scopeType: "folder" });
        expect(content.skills[0]?.name).toBe("Sk");
      });

      it("subtreeMemoryIndex returns descendant memories scoped to the path subtree", async () => {
        const b = makeBackend();
        const api = await b.ensureNodeForPath(WS, "/api");
        const apiSub = await b.ensureNodeForPath(WS, "/api/handlers");
        const web = await b.ensureNodeForPath(WS, "/web");
        await b.writeMemory({ workspaceId: WS, nodeId: api.id, title: "api mem", content: "x" });
        await b.writeMemory({
          workspaceId: WS,
          nodeId: apiSub.id,
          title: "handler mem",
          content: "x",
        });
        await b.writeMemory({ workspaceId: WS, nodeId: web.id, title: "web mem", content: "x" });

        const sub = await b.subtreeMemoryIndex({ workspaceId: WS, relativePath: "/api" }, 50);
        expect(sub.entries.map((e) => e.title).sort()).toEqual(["api mem", "handler mem"]); // /api + descendants, not /web
        expect(sub.total).toBe(2);
        expect(sub.truncated).toBe(false);

        const whole = await b.subtreeMemoryIndex({ workspaceId: WS, relativePath: "/" }, 50);
        expect(whole.total).toBe(3); // "/" covers the whole workspace

        const capped = await b.subtreeMemoryIndex({ workspaceId: WS, relativePath: "/" }, 1);
        expect(capped.entries).toHaveLength(1);
        expect(capped.truncated).toBe(true);
        expect(capped.total).toBe(3);
      });

      it("subtree + relevant-path scoping treat `_`/`%` as literals and match case-sensitively (no LIKE-wildcard leak)", async () => {
        const b = makeBackend();
        // Underscore is a legal path char and a SQL LIKE single-char wildcard. A sibling
        // that differs only where the `_` sits must NOT be pulled into the subtree.
        const under = await b.ensureNodeForPath(WS, "/log_v1");
        const sibling = await b.ensureNodeForPath(WS, "/logXv1");
        const childOfSibling = await b.ensureNodeForPath(WS, "/logXv1/inner");
        await b.writeMemory({ workspaceId: WS, nodeId: under.id, title: "real", content: "x" });
        await b.writeMemory({ workspaceId: WS, nodeId: sibling.id, title: "decoy", content: "x" });
        await b.writeMemory({
          workspaceId: WS,
          nodeId: childOfSibling.id,
          title: "decoy child",
          content: "x",
        });

        const sub = await b.subtreeMemoryIndex({ workspaceId: WS, relativePath: "/log_v1" }, 50);
        expect(sub.entries.map((e) => e.title)).toEqual(["real"]); // not "decoy"/"decoy child"
        expect(sub.total).toBe(1);

        // Case sensitivity: a node at "/Svc" must not own a request for "/svc/handler".
        const svc = await b.ensureNodeForPath(WS, "/Svc");
        await b.writeMemory({ workspaceId: WS, nodeId: svc.id, title: "cased", content: "x" });
        const owners = await b.relevantMemoriesForPath(WS, "/svc/handler.ts");
        expect(owners.some((r) => r.title === "cased")).toBe(false);

        // The exact-case ancestor IS an owner.
        const ownersExact = await b.relevantMemoriesForPath(WS, "/Svc/handler.ts");
        expect(ownersExact.some((r) => r.title === "cased" && r.via === "node_owner")).toBe(true);
      });

      it("projectMapSearch ranks content-bearing nodes by fuzzy relevance, skips empty/unmatched", async () => {
        const b = makeBackend();
        const auth = await b.ensureNodeForPath(WS, "/api/auth");
        const billing = await b.ensureNodeForPath(WS, "/api/billing");
        await b.ensureNodeForPath(WS, "/api/empty"); // no content → never a candidate
        await b.writeMemory({
          workspaceId: WS,
          nodeId: auth.id,
          title: "JWT refresh flow",
          content: "how tokens rotate",
        });
        await b.writeMemory({
          workspaceId: WS,
          nodeId: billing.id,
          title: "Stripe webhook handling",
          content: "invoice events",
        });

        // A query that is a path word matches strongly.
        const hit = await b.projectMapSearch(WS, "auth");
        expect(hit.nodes.length).toBeGreaterThanOrEqual(1);
        expect(hit.nodes[0]!.path).toBe("/api/auth");
        expect(hit.nodes[0]!.relevance).toBeGreaterThanOrEqual(0.3);
        expect(hit.nodes[0]!.match_source).toBe("fuzzy");
        expect(hit.nodes[0]!.memory_titles).toContain("JWT refresh flow");
        expect(hit.topScore).toBeGreaterThanOrEqual(hit.nodes[0]!.relevance - 0.01);
        // The empty node is never returned.
        expect(hit.nodes.some((n) => n.path === "/api/empty")).toBe(false);

        // An unrelated query returns nothing above the cutoff.
        const miss = await b.projectMapSearch(WS, "kubernetes helm chart deployment");
        expect(miss.nodes).toHaveLength(0);

        // Empty query is a clean no-op.
        const empty = await b.projectMapSearch(WS, "   ");
        expect(empty).toEqual({ nodes: [], topScore: 0 });

        // limit caps the result set.
        const both = await b.projectMapSearch(WS, "api", 1);
        expect(both.nodes.length).toBeLessThanOrEqual(1);
      });

      it("listSkillsForInvocation returns active workspace skills with effective content", async () => {
        const b = makeBackend();
        const node = await b.ensureNodeForPath(WS, "/ops");
        await b.writeSkill({ workspaceId: WS, nodeId: node.id, name: "deploy", content: "run it" });
        const skills = await b.listSkillsForInvocation(WS);
        expect(skills).toHaveLength(1);
        expect(skills[0]).toMatchObject({ name: "deploy", content: "run it" });
      });

      it("ensureNodeForPath materialises the chain idempotently", async () => {
        const b = makeBackend();
        const leaf = await b.ensureNodeForPath(WS, "/apps/api");
        expect(leaf.relative_path).toBe("/apps/api");
        const again = await b.ensureNodeForPath(WS, "/apps/api");
        expect(again.id).toBe(leaf.id); // idempotent — no duplicate node
        const paths = (await b.getTree(WS)).map((n) => n.relativePath).sort();
        expect(paths).toEqual(["/", "/apps", "/apps/api"]);
      });
    });

    // Workspace resolution. The resolveWorkspaceFromCwd happy-path needs
    // backend-specific seeding (e.g. registerWorkspace), so it lives in the
    // per-backend test files. closestNode + the no-match/no-node null paths are
    // shared across backends and asserted here.
    describe("workspace resolution", () => {
      it("closestNode walks up to the deepest existing node; null when the workspace has no nodes", async () => {
        const b = makeBackend();
        expect(await b.closestNode(WS, "/api/handlers")).toBeNull(); // no nodes yet

        await b.ensureNodeForPath(WS, "/api/handlers");
        expect((await b.closestNode(WS, "/api/handlers"))?.relativePath).toBe("/api/handlers"); // exact
        expect((await b.closestNode(WS, "/api/handlers/deep/x"))?.relativePath).toBe(
          "/api/handlers",
        ); // walk up
        expect((await b.closestNode(WS, "/api"))?.relativePath).toBe("/api"); // ancestor
        // No node matches a fully-unrelated top-level path (the root node is
        // stored as "/", which closestNode's "" root candidate doesn't hit).
        // The get_context handler treats null as resolved-path "".
        expect(await b.closestNode(WS, "/unrelated")).toBeNull();
      });

      it("resolveWorkspaceFromCwd returns null when no workspace root is registered", async () => {
        expect(await makeBackend().resolveWorkspaceFromCwd("/Users/me/anywhere")).toBeNull();
      });
    });

    describe("write guards", () => {
      it("isDemoWorkspace is false locally", async () => {
        expect(await makeBackend().isDemoWorkspace(WS)).toBe(false);
      });

      it("checkContentDedup flags a normalised duplicate title within scope", async () => {
        const b = makeBackend();
        const node = await b.ensureNodeForPath(WS, "/x");
        await b.writeMemory({
          workspaceId: WS,
          nodeId: node.id,
          title: "Deploy Steps",
          content: "c",
        });
        const hit = await b.checkContentDedup({
          workspaceId: WS,
          kind: "memory",
          nodeId: node.id,
          candidate: "  deploy steps  ",
        });
        expect(hit.duplicate?.title).toBe("Deploy Steps");
        const miss = await b.checkContentDedup({
          workspaceId: WS,
          kind: "memory",
          nodeId: node.id,
          candidate: "Other",
        });
        expect(miss.duplicate).toBeNull();
      });
    });

    describe("activity + refresh queue", () => {
      it("logs and reads recent activity", async () => {
        const b = makeBackend();
        await b.logActivity({
          workspaceId: WS,
          domain: "docs",
          action: "create",
          scope: "project",
          taskSummary: "did x",
        });
        const recent = await b.recentActivities({ workspaceId: WS, relativePath: "/" }, 5);
        expect(recent[0]?.taskSummary).toBe("did x");
      });

      it("recentActivitiesForRouter returns the snake_case router shape incl. node_path + files_touched", async () => {
        const b = makeBackend();
        await b.logActivity({
          workspaceId: WS,
          domain: "backend",
          action: "update",
          scope: "service",
          taskSummary: "router shape",
          nodePath: "/api",
          filesTouched: { total: 1, by_area: { api: ["src/a.ts"] } },
        });
        const rows = await b.recentActivitiesForRouter(WS, 5, "anyone");
        expect(rows.length).toBe(1);
        expect(rows[0]?.task_summary).toBe("router shape");
        expect(rows[0]?.node_path).toBe("/api");
        expect(rows[0]?.files_touched).toEqual({ total: 1, by_area: { api: ["src/a.ts"] } });
      });

      it("getHotPaths ranks recent node_paths by activity count, top-5", async () => {
        const b = makeBackend();
        const log = (nodePath: string) =>
          b.logActivity({
            workspaceId: WS,
            domain: "backend",
            action: "update",
            scope: "service",
            taskSummary: "x",
            nodePath,
          });
        await log("/api");
        await log("/api");
        await log("/web");

        const hot = await b.getHotPaths(WS);
        expect(hot).toEqual([
          { path: "/api", change_count: 2 },
          { path: "/web", change_count: 1 },
        ]);
      });

      it("recordMemoryContextPaths + rankPriorSolutions surface memories by overlapping path", async () => {
        const b = makeBackend();
        const node = await b.ensureNodeForPath(WS, "/api");
        // Activity at /api establishes the "recently active path" the snapshot captures.
        await b.logActivity({
          workspaceId: WS,
          domain: "backend",
          action: "update",
          scope: "service",
          taskSummary: "worked on api",
          nodePath: "/api",
        });
        const m = await b.writeMemory({
          workspaceId: WS,
          nodeId: node.id,
          title: "How auth tokens rotate",
          content: "x".repeat(400),
        });
        await b.recordMemoryContextPaths(m.id, WS);

        const hits = await b.rankPriorSolutions(WS, ["/api"]);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({ memory_id: m.id, title: "How auth tokens rotate" });
        expect(hits[0]!.related_paths).toContain("/api");
        expect(hits[0]!.preview.length).toBe(200); // capped at 200 chars

        // No overlap → nothing; empty matchedPaths → clean no-op.
        expect(await b.rankPriorSolutions(WS, ["/web"])).toHaveLength(0);
        expect(await b.rankPriorSolutions(WS, [])).toHaveLength(0);
      });

      it("findCoupledNodes derives co-change from activities touching paths together", async () => {
        const b = makeBackend();
        const db = await b.ensureNodeForPath(WS, "/db");
        await b.ensureNodeForPath(WS, "/api");
        const touch = () =>
          b.logActivity({
            workspaceId: WS,
            domain: "backend",
            action: "update",
            scope: "service",
            taskSummary: "touched api + db together",
            nodePath: "/api",
            filesTouched: { total: 2, by_area: { backend: ["api/server.ts", "db/schema.ts"] } },
          });
        await touch();
        await touch();

        const coupled = await b.findCoupledNodes(WS, [], ["/api"], 100);
        expect(coupled).toHaveLength(1);
        expect(coupled[0]).toMatchObject({
          path: "/db",
          match_source: "co_change",
          node_id: db.id,
        });
        expect(coupled[0]!.relevance).toBeCloseTo(0.2); // weight 2 → min(1, 2/10)

        // No seeds and no co-touched paths are clean no-ops.
        expect(await b.findCoupledNodes(WS, [], [], 100)).toHaveLength(0);
        expect(await b.findCoupledNodes(WS, [], ["/web"], 100)).toHaveLength(0);
      });

      it("searchWorkEpisodes clusters activities and matches by query; refresh is a local no-op", async () => {
        const b = makeBackend();
        const log = (summary: string, subjects: string[]) =>
          b.logActivity({
            workspaceId: WS,
            domain: "backend",
            action: "update",
            scope: "service",
            taskSummary: summary,
            subjects,
            nodePath: "/api",
          });
        await log("started auth work", ["auth", "jwt"]);
        await log("more auth work", ["auth"]);

        expect(await b.refreshWorkEpisodes(WS)).toEqual({ ok: true, episodes_upserted: 0 });

        // Both share subject "auth" + path "/api" within the window → one episode.
        const found = await b.searchWorkEpisodes(WS, "auth", "compact", 2);
        expect(found).toHaveLength(1);
        expect(found[0]!.activity_count).toBe(2);
        expect(found[0]!.confidence).toBe("medium");
        expect(found[0]!.subjects).toContain("auth");
        expect(found[0]!.paths).toContain("/api");
        expect(found[0]!.evidence_activity_ids).toHaveLength(2);

        // Unrelated query → no episodes.
        expect(await b.searchWorkEpisodes(WS, "kubernetes helm", "compact", 2)).toHaveLength(0);
      });

      it("assembleBriefing composes summary, suggested_order, and internal prior_solutions", async () => {
        const b = makeBackend();
        const api = await b.ensureNodeForPath(WS, "/api");
        await b.logActivity({
          workspaceId: WS,
          domain: "backend",
          action: "update",
          scope: "service",
          taskSummary: "worked on api",
          nodePath: "/api",
        });
        const m = await b.writeMemory({
          workspaceId: WS,
          nodeId: api.id,
          title: "Auth flow",
          content: "y",
        });
        await b.recordMemoryContextPaths(m.id, WS);

        const primaryNodes: NodeBrief[] = [
          {
            node_id: api.id,
            path: "/api",
            name: "api",
            memory_titles: ["Auth flow"],
            rule_names: ["api-rule"],
            skill_names: [],
            match_source: "fuzzy",
            relevance: 0.9,
          },
        ];
        const briefing = await b.assembleBriefing({
          workspaceId: WS,
          intent: "auth",
          primaryNodes,
          coupledNodes: [],
          hotPaths: [{ path: "/api", change_count: 3 }],
          recentSession: null,
        });

        expect(briefing.summary).toContain("Found 1 relevant node");
        expect(briefing.confidence).toBe(0.9);
        expect(briefing.primary_nodes).toHaveLength(1);
        expect(briefing.rules_in_scope?.map((r) => r.name)).toContain("api-rule");
        expect(briefing.hot_paths).toHaveLength(1);
        expect(briefing.prior_solutions?.[0]?.memory_id).toBe(m.id); // computed internally from /api
        expect(briefing.suggested_order).toContain("/api");
        expect(briefing.no_matches).toBeUndefined();

        // A bare briefing with no signal flags no_matches.
        const empty = await b.assembleBriefing({
          workspaceId: WS,
          primaryNodes: [],
          coupledNodes: [],
          hotPaths: [],
          recentSession: null,
          primaryPaths: ["/nowhere"],
        });
        expect(empty.no_matches).toBe(true);
        expect(empty.confidence).toBe(0);
      });

      it("relevantMemoriesForPath unions node-owner (incl. ancestors) and context-link memories", async () => {
        const b = makeBackend();
        const api = await b.ensureNodeForPath(WS, "/api");
        await b.ensureNodeForPath(WS, "/api/handlers");
        const web = await b.ensureNodeForPath(WS, "/web");
        const apiMem = await b.writeMemory({
          workspaceId: WS,
          nodeId: api.id,
          title: "api owner",
          content: "x",
        });
        const webMem = await b.writeMemory({
          workspaceId: WS,
          nodeId: web.id,
          title: "web link",
          content: "x",
        });
        // Link webMem to /api/handlers via a recent activity there + context-path snapshot.
        await b.logActivity({
          workspaceId: WS,
          domain: "backend",
          action: "update",
          scope: "service",
          taskSummary: "x",
          nodePath: "/api/handlers",
        });
        await b.recordMemoryContextPaths(webMem.id, WS);

        const rows = await b.relevantMemoriesForPath(WS, "/api/handlers");
        const byId = new Map(rows.map((r) => [r.memory_id, r]));
        expect(byId.get(apiMem.id)?.via).toBe("node_owner"); // /api is an ancestor of /api/handlers
        expect(byId.get(webMem.id)?.via).toBe("context_link"); // linked via context path
        expect(byId.get(webMem.id)?.matched_path).toBe("/api/handlers");
        expect(rows[0]!.via).toBe("node_owner"); // node-owner sorts first

        // Unrelated path: no owner, no link.
        expect(await b.relevantMemoriesForPath(WS, "/unrelated")).toHaveLength(0);
      });

      it("buildHookIndexPayload assembles path memories/rules, project rules, subjects, skills", async () => {
        const b = makeBackend();
        const api = await b.ensureNodeForPath(WS, "/api");
        const mem = await b.writeMemory({
          workspaceId: WS,
          nodeId: api.id,
          title: "config.json setup",
          content: "how to configure",
        });
        await b.writeRule({
          workspaceId: WS,
          nodeId: api.id,
          name: "api rule",
          content: "always validate",
          scopeType: "folder",
          priority: "high",
        });
        await b.writeRule({
          workspaceId: WS,
          name: "global rule",
          content: "be careful",
          scopeType: "project",
          priority: "medium",
        });
        await b.writeSkill({ workspaceId: WS, nodeId: api.id, name: "Deploy", content: "steps" });
        await b.logActivity({
          workspaceId: WS,
          domain: "backend",
          action: "update",
          scope: "service",
          taskSummary: "x",
          subjects: ["auth", "jwt"],
          nodePath: "/api",
        });

        const idx = await b.buildHookIndexPayload(WS);
        expect(idx).not.toBeNull();
        expect(idx!.schema_version).toBe(2);
        expect(idx!.workspace_id).toBe(WS);
        expect(idx!.workspace_root).toBe(""); // CLI writer fills this
        expect(idx!.path_memories["/api"]?.[0]?.title).toBe("config.json setup");
        expect(idx!.project_rules.map((r) => r.name)).toContain("global rule");
        expect(idx!.path_rules["/api"]?.map((r) => r.name)).toContain("api rule");
        expect(idx!.recent_subjects).toContain("auth");
        expect(idx!.skill_invocation_index?.["deploy"]?.[0]?.name).toBe("Deploy");
        expect(idx!.filename_index?.["config.json"]).toContain(mem.id);
        expect(idx!.pending_refresh_count).toBe(0);
      });

      it("logActivity returns the persisted row, defaults node_path, and normalizes subjects", async () => {
        const b = makeBackend();
        const rec = await b.logActivity({
          workspaceId: WS,
          domain: "backend",
          action: "refactor",
          scope: "service",
          subjects: ["  Sidebar ", "sidebar", "Resize-Handle", ""],
          taskSummary: "rewired logActivity",
        });
        expect(rec.id).toBeTruthy();
        expect(rec.createdAt).toBeTruthy();
        expect(rec.nodePath).toBe("/"); // missing nodePath defaults to root
        expect(rec.aiClient).toBe("claude-code");
        // lowercase + trim + dedupe + cap 5
        expect(rec.subjects).toEqual(["sidebar", "resize-handle"]);
      });

      it("refresh queue: request → claim-on-read → resolve, idempotent per subject", async () => {
        const b = makeBackend();
        const node = await b.ensureNodeForPath(WS, "/svc");
        const m = await b.writeMemory({
          workspaceId: WS,
          nodeId: node.id,
          title: "Stale Memory",
          content: "old body",
        });

        const req = await b.requestRefresh({
          subjectType: "memory",
          subjectId: m.id,
          reason: "drifted from code",
          kind: "drift",
        });
        expect(req.refreshId).toBeTruthy();
        expect(req.alreadyPending).toBe(false);

        // idempotent: a second flag for the same open subject returns the same task
        const again = await b.requestRefresh({
          subjectType: "memory",
          subjectId: m.id,
          reason: "still drifted",
        });
        expect(again.refreshId).toBe(req.refreshId);
        expect(again.alreadyPending).toBe(true);

        const pending = await b.listPendingRefreshes(WS);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.subjectId).toBe(m.id);
        expect(pending[0]?.subjectTitle).toBe("Stale Memory");
        expect(pending[0]?.nodePath).toBe("/svc");
        expect(pending[0]?.hasProposedPatch).toBe(false); // no AI patch locally

        // get brief claims it (pending → in_progress) and reflects the live subject body
        const row = await b.getRefreshBrief(req.refreshId, "claude-code");
        expect(row.status).toBe("in_progress");
        expect(row.brief.subject.title).toBe("Stale Memory");
        expect(row.brief.subject.body).toBe("old body");
        expect(row.brief.proposedPatch).toBeUndefined();

        // a claimed task drops out of the default pending list but shows with includeInProgress
        expect(await b.listPendingRefreshes(WS)).toHaveLength(0);
        expect(await b.listPendingRefreshes(WS, true)).toHaveLength(1);

        const resolved = await b.resolveRefresh(req.refreshId, "applied", "fixed it");
        expect(resolved.status).toBe("applied");
        expect(resolved.resolvedNote).toBe("fixed it");
        expect(await b.listPendingRefreshes(WS, true)).toHaveLength(0);
      });
    });

    describe("capabilities", () => {
      it("reports a pure-local, no-cloud-AI profile (BYO embed wired; no router key)", async () => {
        // The contract suite runs without PATHRULE_AI_ROUTE_KEY, so the BYO
        // ai-route adapter is dormant and routerLLM stays false. It DOES inject a
        // deterministic embed seam, so semantic is true — the managed intelligence
        // (merge/generate/staleness/realtime) stays false.
        expect(process.env.PATHRULE_AI_ROUTE_KEY).toBeFalsy();
        const b = makeBackend();
        expect(b.capabilities()).toEqual({
          aiMerge: false,
          aiGenerate: false,
          staleness: false,
          realtime: false,
          semantic: true,
          routerLLM: false,
        });
        expect(await b.sessionIsCurrent()).toBe(true);
      });

      it("routeIntent degrades to null without a router key (deterministic fallback upstream)", async () => {
        // get_context calls ctx.backend.routeIntent and, on null, degrades to its
        // deterministic router (`router_unavailable`). With no BYO key the local
        // backends must report exactly that — either the optional method is
        // unwired, or it returns null.
        const b = makeBackend();
        if (b.routeIntent) {
          const res = await b.routeIntent({
            workspaceId: WS,
            userIntent: "fix the login bug",
            workspaceOverview: [],
            recentActivities: [],
          });
          expect(res).toBeNull();
        }
        expect(b.capabilities().routerLLM).toBe(false);
      });
    });

    // BYO semantic search. Runs only when the factory wired an embedding seam
    // (capabilities().semantic). The in-memory and SQLite-backed backends must
    // produce shape-identical semantic_candidates payloads.
    describe("semantic candidates", () => {
      it("embeds on write and surfaces the cosine match; unrelated memory is filtered", async () => {
        const b = makeBackend();
        if (!b.capabilities().semantic || !b.semanticCandidates) return;
        const alpha = await b.writeMemory({
          workspaceId: WS,
          nodeId: "n1",
          title: "alpha topic",
          content: "all about alpha",
        });
        await b.writeMemory({
          workspaceId: WS,
          nodeId: "n1",
          title: "beta topic",
          content: "beta beta",
        });
        const res = await b.semanticCandidates({
          workspaceId: WS,
          userIntent: "alpha",
          matchedNodePath: "/",
          bundleMemories: undefined,
          subtreeIndex: undefined,
          discoveryCandidateTitles: undefined,
        });
        expect(res).not.toBeNull();
        const ids = res?.payload?.candidates.map((c) => c.id) ?? [];
        expect(ids).toContain(alpha.id);
        expect(res?.payload?.candidates.every((c) => c.source === "semantic")).toBe(true);
        expect(res?.payload?.searched_scope.matched_node_path).toBe("/");
      });

      it("drops direct (already-shown) ids and marks lexical overlap on title-only ids", async () => {
        const b = makeBackend();
        if (!b.capabilities().semantic || !b.semanticCandidates) return;
        const a = await b.writeMemory({
          workspaceId: WS,
          title: "alpha one",
          content: "alpha alpha",
        });

        // Direct id (already shown with body) → dropped → nothing survives.
        const direct = await b.semanticCandidates({
          workspaceId: WS,
          userIntent: "alpha",
          matchedNodePath: "/",
          bundleMemories: [{ id: a.id }],
          subtreeIndex: undefined,
          discoveryCandidateTitles: undefined,
        });
        expect(direct?.payload).toBeUndefined();
        expect(direct?.skipped).toBe("no_candidates");

        // Title-only overlap → kept, flagged lexical_overlap + high confidence.
        const overlap = await b.semanticCandidates({
          workspaceId: WS,
          userIntent: "alpha",
          matchedNodePath: "/",
          bundleMemories: undefined,
          subtreeIndex: {
            entries: [{ id: a.id, title: "alpha one", node_path: "/" }],
            truncated: false,
            total: 1,
          },
          discoveryCandidateTitles: undefined,
        });
        const cand = overlap?.payload?.candidates.find((c) => c.id === a.id);
        expect(cand?.lexical_overlap).toBe(true);
        expect(cand?.confidence).toBe("high");
      });

      it("empty intent skips; archived memory does not surface", async () => {
        const b = makeBackend();
        if (!b.capabilities().semantic || !b.semanticCandidates) return;
        const empty = await b.semanticCandidates({
          workspaceId: WS,
          userIntent: "   ",
          matchedNodePath: "/",
          bundleMemories: undefined,
          subtreeIndex: undefined,
          discoveryCandidateTitles: undefined,
        });
        expect(empty?.skipped).toBe("empty_intent");

        const a = await b.writeMemory({ workspaceId: WS, title: "alpha", content: "alpha alpha" });
        await b.deleteMemory({ id: a.id }); // soft delete → archived
        const res = await b.semanticCandidates({
          workspaceId: WS,
          userIntent: "alpha",
          matchedNodePath: "/",
          bundleMemories: undefined,
          subtreeIndex: undefined,
          discoveryCandidateTitles: undefined,
        });
        expect(res?.payload).toBeUndefined();
      });
    });
  });
}
