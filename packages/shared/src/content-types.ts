// Shared shapes for the content layer and the MCP read tools.

import type { SkillPackageStatus } from "./skills/package-types.js";

export type MemorySource = "claude" | "manual";
export type SkillSource = "manual" | "template" | "github_ref";
export type RuleScope = "folder" | "file_type" | "project";
export type RulePriority = "high" | "medium" | "low";

/** A single memory row, 1-to-1 with a node via `nodeId`. */
export interface Memory {
  id: string;
  workspaceId: string;
  nodeId: string;
  title: string;
  content: string;
  source: MemorySource;
  versionId: string;
  versionNumber: number;
  createdBy: string | null;
  lastEditedBy: string | null;
  lastEditedAt: string;
  createdAt: string;
  updatedAt: string;
  /** Internal routing tags generated server-side; not user-facing skill/rule tags. */
  semanticTags?: string[];
  /** Number of times this memory was injected into AI context in the active usage window. */
  usageCount30d?: number;
}

/**
 * Skill rows live at workspace scope and attach to nodes via `node_skills`.
 * "Create + attach" is collapsed into one flow.
 */
export interface Skill {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  content: string;
  source: SkillSource;
  githubUrl: string | null;
  version: string;
  tags: string[];
  versionId: string;
  versionNumber: number;
  /** Internal routing tags generated server-side. User-facing tags remain `tags`. */
  semanticTags?: string[];
  createdBy: string | null;
  lastEditedBy: string | null;
  lastEditedAt: string;
  createdAt: string;
  updatedAt: string;
  /** When skill.content was last refreshed from githubUrl. NULL for non-github_ref. */
  contentFetchedAt: string | null;
  packageFormatVersion?: number;
  packageSnapshotAt?: string | null;
  packageSourceUrl?: string | null;
  packageResolvedUrl?: string | null;
  packageSourceRef?: string | null;
  packageSourceSha?: string | null;
  packageDeveloper?: string | null;
  packageFileCount?: number;
  packageExcludedCount?: number;
  packageStatus?: SkillPackageStatus;
}

/**
 * Rules live at workspace scope and attach to nodes via `node_rules`.
 * Priority + scope drive how the agent weighs them in get_context.
 */
export interface Rule {
  id: string;
  workspaceId: string;
  name: string;
  content: string;
  scopeType: RuleScope;
  priority: RulePriority;
  versionId: string;
  versionNumber: number;
  createdBy: string | null;
  lastEditedBy: string | null;
  lastEditedAt: string;
  createdAt: string;
  updatedAt: string;
  /** Internal routing tags generated server-side; not shown as author-managed rule metadata. */
  semanticTags?: string[];
  /** Number of times this rule was injected into AI context in the active usage window. */
  usageCount30d?: number;
}

// MainMemoryEntry was an earlier per-node "router" UI shape. Replaced by
// the project-level CLAUDE.md (rendered in shared/claude-md-project.ts).

// Comment system types.

export type CommentTargetKind = "memory" | "rule" | "skill";

export interface Comment {
  id: string;
  workspaceId: string;
  targetKind: CommentTargetKind;
  targetId: string;
  authorId: string;
  body: string;
  lineStart: number | null;
  lineEnd: number | null;
  lineSnapshot: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  mentionedUserIds: string[];
  isReadByMe: boolean;
}

export interface ThreadState {
  workspaceId: string;
  targetKind: CommentTargetKind;
  targetId: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}
