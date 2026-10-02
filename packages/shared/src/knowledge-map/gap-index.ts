// Open knowledge gaps for the hook index. Node-only (git, file reads), so it has
// its own subpath and imports only the modules it needs: the OSS local runtime reaches it
// through hook-index-writer and must not pull the map's partitioner along.
//
// Zero cost by default: with knowledgeGapDelivery off (the default until a labelled precision
// run passes 0.70) it returns [] before touching anything. On, a warm call costs `git rev-parse
// HEAD` plus the knowledge fingerprint: history and the map input are read once per (knowledge
// fingerprint, checked-out commit, day) and shared by concurrent callers. The TTL bounds what the
// key cannot see: a dismissal, or a working-tree edit that makes a claim stale.

import type { KnowledgeBackend } from "@pathrule/core";
import type { KnowledgeGapStub } from "../hook-supervisor/types.js";
import { isMaintenanceCapabilityEnabled, resolveMaintenanceFeatureFlags } from "../maintenance/feature-flags.js";
import { verifyLearningSources } from "../project-learning/claim-service.js";
import { extractPathAnchors, normalizeAnchorPath, resolveItemAnchors } from "./anchors.js";
import { computeCoverageGaps, type CoverageAnchor, type KnowledgeGap } from "./coverage.js";
import { gapScopeOverlaps, gapStub } from "./gap-delivery.js";
import { readGitActivity, readGitHead } from "./git-activity.js";

const CACHE_TTL_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const CLAIM_LIMIT = 100;
const cache = new Map<string, { at: number; stubs: KnowledgeGapStub[] }>();
const running = new Map<string, Promise<KnowledgeGapStub[]>>();

export function knowledgeGapDeliveryEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return isMaintenanceCapabilityEnabled(resolveMaintenanceFeatureFlags({ env }), "knowledgeGapDelivery");
}

export async function knowledgeGapStubsForIndex(args: {
  backend: KnowledgeBackend;
  workspaceId: string;
  workspaceRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  now?: number;
}): Promise<KnowledgeGapStub[]> {
  if (!knowledgeGapDeliveryEnabled(args.env)) return [];
  const { backend, workspaceId, workspaceRoot } = args;
  if (!backend.buildKnowledgeMapInput || !backend.knowledgeMapFingerprint) return [];
  const now = args.now ?? Date.now();
  try {
    const [head, fingerprint] = await Promise.all([readGitHead(workspaceRoot), backend.knowledgeMapFingerprint(workspaceId)]);
    if (!head) return [];
    // The coverage window slides by the day, so the day is part of the key.
    const prefix = `${workspaceId}\u0000${workspaceRoot}\u0000`;
    const key = `${prefix}${fingerprint}\u0000${head}\u0000${Math.floor(now / DAY_MS)}`;
    const hit = cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.stubs;
    let job = running.get(key);
    if (!job) {
      const started = computeStubs(backend, workspaceId, workspaceRoot, now).then((stubs) => {
        for (const old of cache.keys()) if (old.startsWith(prefix)) cache.delete(old);
        cache.set(key, { at: now, stubs });
        return stubs;
      });
      job = started;
      running.set(key, started);
      void started.finally(() => running.delete(key)).catch(() => {});
    }
    return await job;
  } catch {
    // Delivery is advisory: a failure here must never block writing the index or a turn.
    return [];
  }
}

async function computeStubs(backend: KnowledgeBackend, workspaceId: string, workspaceRoot: string, now: number): Promise<KnowledgeGapStub[]> {
  return (await computeWorkspaceGaps({ backend, workspaceId, workspaceRoot, now })).map(gapStub);
}

/**
 * The open gaps of a checkout against a backend's knowledge, minus dismissed scopes. Uncached
 * and flag-free: delivery goes through knowledgeGapStubsForIndex; the benchmark calls this.
 */
export async function computeWorkspaceGaps(args: {
  backend: KnowledgeBackend;
  workspaceId: string;
  workspaceRoot: string;
  now?: number;
}): Promise<KnowledgeGap[]> {
  const { backend, workspaceId, workspaceRoot } = args;
  const now = args.now ?? Date.now();
  const commits = await readGitActivity(workspaceRoot);
  if (commits.length === 0) return [];
  const input = await backend.buildKnowledgeMapInput?.(workspaceId);
  if (!input) return [];
  const anchors: CoverageAnchor[] = [];
  for (const item of input.items) {
    const updatedAt = Math.floor((Date.parse(item.updatedAt) || 0) / 1000);
    const refs = extractPathAnchors(`${item.body}\n${item.description ?? ""}`);
    for (const path of resolveItemAnchors(refs, item.nodePaths)) anchors.push({ path, updatedAt, source: "path_ref" });
    for (const nodePath of item.nodePaths) {
      const path = normalizeAnchorPath(nodePath);
      if (path) anchors.push({ path, updatedAt, source: "node" });
    }
  }
  // A claim anchors its sources while their digests still match the working tree; it then
  // describes the current bytes, so it counts as fresh.
  for (const claim of (await backend.listLearningClaims?.(workspaceId, CLAIM_LIMIT)) ?? []) {
    if ((await verifyLearningSources(workspaceRoot, claim.sources)) !== "current") continue;
    for (const source of claim.sources) anchors.push({ path: source.path, updatedAt: Math.floor(now / 1000), source: "claim" });
  }
  const suppressedScopes = (await backend.knowledgeGapSuppressedScopes?.(workspaceId)) ?? [];
  return computeCoverageGaps({ commits, anchors, suppressedScopes, now: Math.floor(now / 1000) });
}

/** Open gaps overlapping a turn's scope (see gapScopeOverlaps), before any per-session filter. */
export async function knowledgeGapsForScope(args: Parameters<typeof knowledgeGapStubsForIndex>[0] & { scope: string }): Promise<KnowledgeGapStub[]> {
  const stubs = await knowledgeGapStubsForIndex(args);
  return stubs.filter((stub) => gapScopeOverlaps(stub.scope, args.scope));
}

export function clearKnowledgeGapIndexCache(): void {
  cache.clear();
  running.clear();
}
