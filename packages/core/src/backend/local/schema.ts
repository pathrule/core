// SPDX-License-Identifier: Apache-2.0
/**
 * Embedded SQLite schema for LocalBackend. Holds only the content tables —
 * no billing/team/auth columns. Source of truth for the OSS edition.
 * Idempotent (CREATE ... IF NOT EXISTS) so it doubles as the bootstrap + the migration base.
 *
 * Schema evolution: the canonical store at `~/.pathrule/<ws>/pathrule.db` upgrades
 * via the numbered MIGRATIONS list below, gated on `PRAGMA user_version`. v1 is the full base
 * schema; future schema changes append `{ version: N, sql }` deltas — never
 * edit a released migration. `SCHEMA_VERSION` is the latest version a fresh DB ends up at.
 */
export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  local_root_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  orphaned_at TEXT,
  original_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_ws ON nodes(workspace_id);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  node_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'claude',
  version_id TEXT NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  last_edited_by TEXT,
  last_edited_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_memories_ws ON memories(workspace_id, status);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  version_id TEXT NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  last_edited_by TEXT,
  last_edited_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_rules_ws ON rules(workspace_id, status);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  github_url TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  tags TEXT NOT NULL DEFAULT '[]',
  version_id TEXT NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  last_edited_by TEXT,
  last_edited_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content_fetched_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_skills_ws ON skills(workspace_id, status);

CREATE TABLE IF NOT EXISTS node_rules (
  node_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  PRIMARY KEY (node_id, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_node_rules_rule ON node_rules(rule_id);

CREATE TABLE IF NOT EXISTS node_skills (
  node_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (node_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_node_skills_skill ON node_skills(skill_id);

CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  node_path TEXT,
  domain TEXT,
  action TEXT,
  scope TEXT,
  subjects TEXT NOT NULL DEFAULT '[]',
  task_summary TEXT,
  files_touched TEXT NOT NULL DEFAULT '[]',
  ai_client TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_ws ON activity_logs(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS refresh_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'memory',
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'drift',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  claimed_by_ai TEXT,
  claimed_at TEXT,
  resolved_at TEXT,
  resolved_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_ws ON refresh_tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_refresh_subject ON refresh_tasks(subject_id, status);

-- Path snapshot read by rankPriorSolutions (and relevantMemoriesForPath).
-- (memory_id, path) populated by recordMemoryContextPaths: the workspace-relative
-- paths active when a memory was written.
CREATE TABLE IF NOT EXISTS memory_context_paths (
  memory_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (memory_id, path)
);
CREATE INDEX IF NOT EXISTS idx_memory_context_paths_path ON memory_context_paths(path);

-- Bring-your-own semantic store. One embedding row per memory, written by
-- LocalBackend on memory write/update when an embedding key is configured.
-- The vector is stored as a packed float32 BLOB (the same width vector stores use;
-- read back with a Float32Array view, no per-query parse) for a solo-scale
-- brute-force cosine scan; dims/model are kept per row so a query only compares
-- matching-dimension vectors.
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_ws ON memory_embeddings(workspace_id);
`;

// Delta applied to DBs already at v1 (the table is in SCHEMA_SQL for fresh DBs).
// Historical: created the embedding column as TEXT (JSON). v3 converts it to BLOB —
// left unedited (an append-only migration log), v3 supersedes the storage format.
const MIGRATION_V2_EMBEDDINGS = `
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  embedding TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_ws ON memory_embeddings(workspace_id);
`;

// Convert the embedding store from JSON-text to packed float32 BLOB. Embeddings are
// derived (recomputed from a memory's text on its next write/update) and only present
// when a bring-your-own embedding key is configured, so dropping the old rows is safe —
// no source-of-truth is lost. Recreate (not ALTER) since the column's storage changes.
const MIGRATION_V3_EMBEDDINGS_BLOB = `
DROP TABLE IF EXISTS memory_embeddings;
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_ws ON memory_embeddings(workspace_id);
`;

/**
 * Ordered, append-only migration list applied by LocalBackend on open (gated on
 * `PRAGMA user_version`). v1 is the full idempotent base schema, so it is a safe no-op on a
 * DB created by the pre-migration-runner bootstrap. Add new versions as deltas; never mutate
 * an existing entry.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_SQL },
  { version: 2, sql: MIGRATION_V2_EMBEDDINGS },
  { version: 3, sql: MIGRATION_V3_EMBEDDINGS_BLOB },
];
