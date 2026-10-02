// SPDX-License-Identifier: Apache-2.0
/**
 * The oversight map: per high-risk domain, would anyone catch the agent's mistake?
 *
 * The question a per-domain "competence" score is really asked to answer is not how much this person
 * knows about authentication, but whether an agent's error in authentication code would be noticed
 * before it ships. That is what decides how hard the agent must check its own work, and it is what can
 * be measured without a quiz: after the agent changes code in a domain, did the person change that code
 * before moving on?
 *
 * What the count can and cannot say, because it decides how it may be used:
 *
 *  - CHANGED is evidence of review. Someone edited what the agent wrote (beyond a formatter pass), cut
 *    some of it, deleted a file or reverted the change. All of that needs reading the code first.
 *  - LEFT AS IS is NOT evidence of no review. The code may have been read and found right. So a low
 *    rate never means "this person is weak here"; it means Pathrule cannot tell whether a review would
 *    catch a mistake, which is exactly when the agent has to be its own check.
 *
 * Hence the one direction this map acts in. Where the evidence does not show review (or there is none
 * yet), a high-risk task gets a short instruction to verify the change itself. Where it does, nothing is
 * added; nothing is ever removed either, so no level here can lower the bar the agent would otherwise
 * hold. It adds no approval step: the person is never asked anything.
 *
 * The rate is a Beta(1, 1) posterior mean over observed episodes, like the behaviour tallies, and three
 * episodes are needed before a level other than "no evidence" is shown. Recorded only while learning
 * from edits is switched on, and stored as counts in a 0600 file next to the knowledge store.
 */
import { join } from "node:path";
import { hashUserIdForPath, pathruleHome } from "../local-runtime/paths.js";
import type { FileObservation } from "./edit-evidence.js";
import type { GuidanceEntry, OversightLevel, OversightSummary } from "./guidance-types.js";
import { readPrivateJson, serializedWrite, writePrivateJson } from "./private-store.js";
import { RISK_DOMAINS, RISK_TERMS_BY_DOMAIN, classifyPathRisk, classifyTaskRisk, type RiskDomain } from "./risk-gate.js";

export type { GuidanceEntry, OversightLevel, OversightSummary };

export interface OversightTally {
  domain: RiskDomain;
  /** Observed episodes in which the agent changed code in this domain. */
  episodes: number;
  /** Of those, the episodes in which the person changed that code before their next turn. */
  reviewed: number;
  workspaces: string[];
  recent: Array<{ at: string; reviewed: boolean; detail: string }>;
}

export const OVERSIGHT_THRESHOLDS = {
  /** Episodes before the map claims anything. */
  minEpisodes: 3,
  /** Posterior mean of the review rate at or above which review is taken as evidenced. */
  reviewedRate: 0.5,
} as const;

const MAX_RECENT = 12;
const MAX_WORKSPACES = 25;

export function oversightRate(t: Pick<OversightTally, "episodes" | "reviewed">): number {
  return (1 + t.reviewed) / (2 + t.episodes);
}

export function oversightLevel(t: Pick<OversightTally, "episodes" | "reviewed"> | undefined): OversightLevel {
  if (!t || t.episodes < OVERSIGHT_THRESHOLDS.minEpisodes) return "unknown";
  return oversightRate(t) >= OVERSIGHT_THRESHOLDS.reviewedRate ? "reviewed" : "unreviewed";
}

/** The domains one agent turn touched: its prompt's and its files'. */
export function episodeDomains(taskText: string, paths: readonly string[]): RiskDomain[] {
  const out = new Set<RiskDomain>(classifyTaskRisk(taskText).domains);
  for (const p of paths) for (const d of classifyPathRisk(p)) out.add(d);
  return RISK_DOMAINS.filter((d) => out.has(d));
}

export interface OversightOutcome {
  domain: RiskDomain;
  reviewed: boolean;
  detail: string;
}

/**
 * What one observed episode says about each domain it touched.
 *
 * The files that count for a domain are the ones whose path sits in it. A domain known only from the
 * prompt ("fix the login redirect" editing `router.ts`) counts every file of the episode, because those
 * are the files the task about that domain changed.
 */
export function oversightOutcomes(domains: readonly RiskDomain[], files: readonly FileObservation[]): OversightOutcome[] {
  if (files.length === 0) return [];
  const out: OversightOutcome[] = [];
  for (const domain of domains) {
    const inDomain = files.filter((f) => classifyPathRisk(f.path).includes(domain));
    const relevant = inDomain.length > 0 ? inDomain : files;
    const changed = relevant.filter((f) => f.edited || f.deleted || f.removed > 0);
    out.push({
      domain,
      reviewed: changed.length > 0,
      detail: `${changed.length} of ${relevant.length} files changed (${relevant.map((f) => f.path).slice(0, 3).join(", ")})`.slice(0, 200),
    });
  }
  return out;
}

export function applyOversightOutcome(
  tally: OversightTally,
  outcome: OversightOutcome,
  ctx: { at: string; workspace_id: string | null },
): OversightTally {
  const workspaces = ctx.workspace_id && !tally.workspaces.includes(ctx.workspace_id)
    ? [...tally.workspaces, ctx.workspace_id].slice(-MAX_WORKSPACES)
    : tally.workspaces;
  return {
    ...tally,
    episodes: tally.episodes + 1,
    reviewed: tally.reviewed + (outcome.reviewed ? 1 : 0),
    workspaces,
    recent: [...tally.recent, { at: ctx.at, reviewed: outcome.reviewed, detail: outcome.detail }].slice(-MAX_RECENT),
  };
}

export function summarizeOversight(tallies: readonly OversightTally[]): OversightSummary[] {
  const by = new Map(tallies.map((t) => [t.domain, t] as const));
  return RISK_DOMAINS.map((domain) => {
    const t = by.get(domain);
    return { domain, level: oversightLevel(t), episodes: t?.episodes ?? 0, reviewed: t?.reviewed ?? 0 };
  });
}

// ─── What the agent is told ───────────────────────────────────────────────────

const DOMAIN_NAME: Record<RiskDomain, string> = {
  auth: "Authentication and permissions",
  crypto: "Cryptography and secrets",
  payments: "Payments and billing",
  data: "Data, schemas and migrations",
  security: "Security-sensitive code",
};

/**
 * Heading plus framing, as one string, so the standalone hook can print it without knowing any of this.
 * Says why (silent, expensive mistakes; no evidence a review would catch one) and what to do, and never
 * asks the agent to stop and wait for the person.
 */
export const OVERSIGHT_HEADING =
  "## Verify these changes yourself\nMistakes in this kind of code fail silently, and Pathrule has no evidence that a review would catch one here. Before calling the work done, exercise the change (a test, a run or a query) and say plainly what you could not check.";

export function renderOversightLine(domain: RiskDomain, t: Pick<OversightTally, "episodes" | "reviewed"> | undefined): string {
  const name = DOMAIN_NAME[domain];
  if (oversightLevel(t) === "unknown") return `- ${name}: no agent change here has been followed yet.`;
  return `- ${name}: the person changed ${t!.reviewed} of the last ${t!.episodes} agent changes here before moving on.`;
}

/**
 * The section for one task: only the high-risk domains it touches where review is not evidenced. What it
 * touches is read from language-neutral signals only: the identifiers the task names, and the path the
 * work is scoped to.
 */
export function oversightSectionForTask(tallies: readonly OversightTally[], taskText: string, path?: string | null): string {
  const by = new Map(tallies.map((t) => [t.domain, t] as const));
  const touched = new Set<RiskDomain>([...classifyTaskRisk(taskText).domains, ...(path ? classifyPathRisk(path) : [])]);
  const lines = RISK_DOMAINS.filter((d) => touched.has(d))
    .filter((d) => oversightLevel(by.get(d)) !== "reviewed")
    .map((d) => renderOversightLine(d, by.get(d)));
  return lines.length > 0 ? [OVERSIGHT_HEADING, ...lines].join("\n") : "";
}

export function oversightEntriesForIndex(tallies: readonly OversightTally[]): GuidanceEntry[] {
  const by = new Map(tallies.map((t) => [t.domain, t] as const));
  return RISK_DOMAINS.filter((d) => oversightLevel(by.get(d)) !== "reviewed").map((d) => ({
    id: `oversight:${d}`,
    heading: OVERSIGHT_HEADING,
    line: renderOversightLine(d, by.get(d)),
    terms: [...RISK_TERMS_BY_DOMAIN[d]],
  }));
}

// ─── Storage ──────────────────────────────────────────────────────────────────

interface OversightFile {
  schema_version: 1;
  tallies: OversightTally[];
  updated_at: string;
}

export function oversightPath(userKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(pathruleHome(env), "user-intelligence", `${hashUserIdForPath(userKey)}.oversight.json`);
}

function validTally(t: unknown): t is OversightTally {
  if (!t || typeof t !== "object") return false;
  const r = t as Record<string, unknown>;
  return RISK_DOMAINS.includes(r["domain"] as RiskDomain) && typeof r["episodes"] === "number" && typeof r["reviewed"] === "number";
}

export async function readOversight(userKey: string, env: NodeJS.ProcessEnv = process.env): Promise<OversightTally[]> {
  const raw = await readPrivateJson<OversightFile>(oversightPath(userKey, env));
  if (!raw || raw.schema_version !== 1 || !Array.isArray(raw.tallies)) return [];
  return raw.tallies.filter(validTally).map((t) => ({
    ...t,
    workspaces: Array.isArray(t.workspaces) ? t.workspaces : [],
    recent: Array.isArray(t.recent) ? t.recent : [],
  }));
}

export async function recordOversight(
  userKey: string,
  outcomes: readonly OversightOutcome[],
  ctx: { workspace_id: string | null; now: string; env?: NodeJS.ProcessEnv },
): Promise<void> {
  if (outcomes.length === 0) return;
  const env = ctx.env ?? process.env;
  const path = oversightPath(userKey, env);
  await serializedWrite(path, async () => {
    const tallies = new Map((await readOversight(userKey, env)).map((t) => [t.domain, t] as const));
    for (const outcome of outcomes) {
      const prev = tallies.get(outcome.domain) ?? { domain: outcome.domain, episodes: 0, reviewed: 0, workspaces: [], recent: [] };
      tallies.set(outcome.domain, applyOversightOutcome(prev, outcome, { at: ctx.now, workspace_id: ctx.workspace_id }));
    }
    await writePrivateJson(path, { schema_version: 1, tallies: [...tallies.values()], updated_at: ctx.now } satisfies OversightFile);
  });
}
