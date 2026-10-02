export type WorkStateGitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "unknown";

export interface FileWorkStateRow {
  workspace_id: string;
  user_id: string;
  runtime_id: string;
  relative_path: string;
  is_active: boolean;
  is_dirty: boolean;
  git_status: WorkStateGitStatus;
  last_heartbeat_at: string | null;
  last_local_write_at: string | null;
  last_git_scan_at: string;
}

export interface FileWorkConflict {
  user_id: string;
  display_name: string;
  relative_path: string;
  reason: "active" | "dirty" | "active_dirty";
  git_status: WorkStateGitStatus;
  last_heartbeat_at: string | null;
  last_local_write_at: string | null;
}

export interface FileWorkConflictDecision {
  decision: "allow" | "ask";
  conflicts: FileWorkConflict[];
  message?: string;
  source: "snapshot" | "cloud_rpc" | "degraded";
  latency_ms: number;
}

export interface WorkStateSnapshot {
  schema_version: 1;
  workspace_id: string;
  generated_at: string;
  active_ttl_ms: number;
  rows_by_path: Record<string, FileWorkStateRow[]>;
  display_names_by_user_id: Record<string, string>;
}

export interface WorkStatePublishRow {
  relative_path: string;
  is_active?: boolean;
  is_dirty?: boolean;
  git_status?: WorkStateGitStatus;
  last_heartbeat_at?: string | null;
  last_local_write_at?: string | null;
  last_git_scan_at?: string | null;
}

export const WORK_STATE_ACTIVE_TTL_MS = 30_000;
export const WORK_STATE_SNAPSHOT_FRESH_MS = 15_000;
export const WORK_STATE_SNAPSHOT_FILE = "work-state-snapshot.json";

export function isWorkStateGitStatus(value: unknown): value is WorkStateGitStatus {
  return (
    value === "modified" ||
    value === "added" ||
    value === "deleted" ||
    value === "renamed" ||
    value === "untracked" ||
    value === "unknown"
  );
}
