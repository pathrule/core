// Claude Code knowledge renderer — Native Knowledge Compilation only.
//
// Deliberately does NOT touch the root CLAUDE.md (that stays with the bespoke
// claude-md-project.ts pipeline / Hook Supervisor ownership). It emits only:
//
//   1. `.claude/rules/pathrule-knowledge.md` — root-scoped knowledge. Claude
//      Code auto-loads `.claude/rules/*.md` as project instructions at turn
//      zero (same channel as pathrule-protocol.md).
//   2. `<dir>/CLAUDE.md` — per-directory knowledge. Claude Code natively
//      lazy-loads a directory's CLAUDE.md when work enters that directory,
//      which is exactly the path-scoped, cached, turn-zero-positioned channel
//      we want knowledge delivered through.

import {
  KNOWLEDGE_BANNER,
  appendTeamContextSection,
  dirRelative,
  knowledgeFileBody,
  knowledgeOwnedPaths,
  renderKnowledgeFiles,
  rootKnowledge,
} from "./knowledge-files.js";
import { renderTeamContextBlock } from "./team-context-block.js";
import type { ClientRendererSpec, MultiClientInput, RenderedFile } from "./types.js";

const ROOT_KNOWLEDGE_PATH = ".claude/rules/pathrule-knowledge.md";
const ROOT_KNOWLEDGE_TITLE = "# Workspace knowledge (Pathrule)";

/** Claude's native path-scoped channel: the directory's own CLAUDE.md. */
const knowledgePath = (dirPath: string, _slug: string): string =>
  `${dirRelative(dirPath)}/CLAUDE.md`;

function renderClaudeKnowledge(input: MultiClientInput): RenderedFile[] {
  // Signature mode: write nothing into the user's tree.
  //
  // The measured complaint was never the token cost — it was 26 Pathrule-authored
  // files across 13 directories of a checkout the team owns. Removing the
  // protocol copy alone left 25 of them, because this renderer never read
  // `companionMode`: signature ON and OFF produced byte-identical output.
  //
  // Returning no files while `ownedPaths` stays complete is what makes the
  // removal happen rather than merely stopping: disk-writer sweeps every owned
  // path this run did not emit, and it already refuses to delete a file without a
  // Pathrule marker and retracts only the region from one the user shares. The
  // alternative — narrowing ownedPaths too — is how `pathrule-protocol.md` ended
  // up needing its own bespoke remover.
  //
  // What the files carried still reaches the agent: knowledge through the hook's
  // per-prompt selection (measured 2026-09-01: +673 tokens over 20 turns, +5%,
  // because the hook was already ranking the same items), and the team context
  // block through the hook index, which is where `index.team_context` comes from.
  if (input.companionMode === "signature") return [];

  const files: RenderedFile[] = [];
  const root = rootKnowledge(input);
  if (root) {
    files.push({
      path: ROOT_KNOWLEDGE_PATH,
      // Team context rides the same turn-zero file, appended last so the
      // knowledge above it stays byte-identical for the prompt cache.
      body: appendTeamContextSection(knowledgeFileBody(root, ROOT_KNOWLEDGE_TITLE), input),
    });
  } else if (renderTeamContextBlock(input.teamContext)) {
    // A workspace can have team context and no compiled root knowledge yet.
    // The block still has to reach turn zero, so the file carries it alone.
    files.push({
      path: ROOT_KNOWLEDGE_PATH,
      body: appendTeamContextSection(`${KNOWLEDGE_BANNER}\n${ROOT_KNOWLEDGE_TITLE}\n`, input),
    });
  }
  files.push(...renderKnowledgeFiles(input, knowledgePath));
  return files;
}

function ownedPaths(input: MultiClientInput): string[] {
  return [ROOT_KNOWLEDGE_PATH, ...knowledgeOwnedPaths(input, knowledgePath)];
}

export const claudeKnowledgeRenderer: ClientRendererSpec = {
  id: "claude-code",
  render: renderClaudeKnowledge,
  ownedPaths,
};
