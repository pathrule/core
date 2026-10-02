// SPDX-License-Identifier: Apache-2.0
// LocalBackend's activity_logs writes and the content-free learning evidence read from
// them. Kept out of local-backend.ts (a tracked hotspot) so the class methods delegate
// here in one line each; the statements are the class's own, moved verbatim.

import type Database from "better-sqlite3";
import {
  normalizeActivityProvenance,
  type LearningActivity,
} from "@pathrule/shared/intelligence/activity-learning.js";
import type { ActivityRecord, LogActivityInput } from "../inputs.js";
import { normalizeActivitySubjects } from "../in-memory-backend.js";

type Db = InstanceType<typeof Database>;

export function insertActivityRow(
  db: Db,
  input: LogActivityInput,
  id: string,
  createdAt: string,
): ActivityRecord {
  const provenance = normalizeActivityProvenance(input.provenance);
  const subjects = normalizeActivitySubjects(input.subjects);
  const nodePath = input.nodePath || "/";
  const filesTouched = input.filesTouched ?? { total: 0, by_area: {} };
  const aiClient = input.aiClient ?? "claude-code";
  // Friction counts + applied-memory signals are not stored locally.
  db.prepare(
    `INSERT INTO activity_logs (id, workspace_id, node_path, domain, action, scope, subjects,
          task_summary, files_touched, ai_client, created_at, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspaceId,
    nodePath,
    input.domain,
    input.action,
    input.scope,
    JSON.stringify(subjects),
    input.taskSummary,
    JSON.stringify(filesTouched),
    aiClient,
    createdAt,
    provenance ? JSON.stringify(provenance) : null,
  );
  return {
    id,
    workspaceId: input.workspaceId,
    nodePath,
    domain: input.domain,
    action: input.action,
    scope: input.scope,
    subjects,
    taskSummary: input.taskSummary,
    filesTouched,
    aiClient,
    detailLevel: "standard",
    status: "active",
    provenance,
    createdAt,
  };
}

export function learningActivityRows(db: Db, workspaceId: string, limit = 200): LearningActivity[] {
  const rows = db
    .prepare(
      "SELECT id, created_at, files_touched, provenance FROM activity_logs WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    )
    .all(workspaceId, Math.max(1, Math.min(200, limit))) as Array<Record<string, unknown>>;
  const parse = (value: unknown): unknown => {
    try {
      return JSON.parse(String(value));
    } catch {
      return null;
    }
  };
  return rows.map((r) => ({
    id: String(r.id),
    createdAt: String(r.created_at),
    filesTouched: (parse(r.files_touched) ?? {}) as LearningActivity["filesTouched"],
    provenance: normalizeActivityProvenance(parse(r.provenance)),
  }));
}
