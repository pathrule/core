// OpenAI Codex CLI renderer. Emits four files so Codex auto-loads Pathrule's
// protocol AND fires the Pathrule hook script:
//
//   1. AGENTS.md — Codex's auto-loaded project protocol (Markdown). The
//      Pathrule marker injected by renderProtocolBody lets safe-write back up
//      the user's pre-existing AGENTS.md before the first overwrite.
//   2. .codex/hooks.json — JSON hook config. Same shape Claude expects;
//      ensureCodexHooks merger preserves any user-defined hooks under
//      unrelated event keys.
//   3. .codex/config.toml — appends `[features] codex_hooks = true` inside a
//      marker-bound block so Codex actually loads hooks at all. User TOML
//      content is preserved by the ensureCodexConfigToml merger.
//
// The Codex hook output schema (https://developers.openai.com/codex/hooks) is
// Claude-shape compatible — `hookSpecificOutput.additionalContext`,
// `decision: "block"`, `permissionDecision: "deny"` all carry the same
// semantics. Only the tool surface diverges (apply_patch instead of
// Edit/Write, no Read hook), which we adapt in the matcher map.

import { renderProtocolBody } from "./body.js";
import { buildHookConfig, renderCodexHooks } from "../hook-supervisor/client-config-writer.js";
import { ensureCodexConfigToml } from "../pathrule-protocol.js";
import { splicePromotedRulesSection } from "./promoted-rules-section.js";
import {
  appendRootKnowledgeSection,
  dirRelative,
  knowledgeOwnedPaths,
  renderKnowledgeFiles,
} from "./knowledge-files.js";
import type { ClientRendererSpec, MultiClientInput, RenderedFile } from "./types.js";

const PRIMARY_PATH = "AGENTS.md";
const HOOKS_PATH = ".codex/hooks.json";
const CONFIG_PATH = ".codex/config.toml";

/** Codex auto-loads nested AGENTS.md files — its native path-scoped channel. */
const knowledgePath = (dirPath: string, _slug: string): string =>
  `${dirRelative(dirPath)}/AGENTS.md`;

function renderCodex(input: MultiClientInput): RenderedFile[] {
  let body = renderProtocolBody(input, { toolLabel: "Codex", mode: "slim" });

  // Inject promoted_rules section (client-neutral, same content as all other clients).
  if (input.promotedRules) {
    body = splicePromotedRulesSection(body, input.promotedRules, {
      headingLevel: 2,
      includeAttribution: true,
    });
  }
  // Native Knowledge Compilation — root knowledge rides the auto-loaded file.
  body = appendRootKnowledgeSection(body, input);

  const hooksBody = renderCodexHooks(buildHookConfig());
  // First-write seed for config.toml; the merger in safe-write handles the
  // marker-bound block on every subsequent run, so this body only matters
  // when no .codex/config.toml exists yet.
  const configSeed = ensureCodexConfigToml(null).body;
  return [
    { path: PRIMARY_PATH, body },
    { path: HOOKS_PATH, body: hooksBody },
    { path: CONFIG_PATH, body: configSeed },
    // Per-directory knowledge files (nested AGENTS.md), lazy-loaded by Codex.
    ...renderKnowledgeFiles(input, knowledgePath),
  ];
}

function ownedPaths(input: MultiClientInput): string[] {
  // `codex.md` was used briefly during the early onboarding one-shot writer;
  // sweep cleans up the legacy filename if it lingers.
  return [
    PRIMARY_PATH,
    "codex.md",
    HOOKS_PATH,
    CONFIG_PATH,
    ...knowledgeOwnedPaths(input, knowledgePath),
  ];
}

export const codexRenderer: ClientRendererSpec = {
  id: "codex",
  render: renderCodex,
  ownedPaths,
};
