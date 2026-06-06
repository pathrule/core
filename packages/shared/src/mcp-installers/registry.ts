// Single source of truth: which AgentTargetId maps to which installer. The
// Electron orchestrator iterates over this; new clients just slot in here.

import type { AgentTargetId } from "../skills/agent-targets.js";
import { claudeInstaller } from "./claude-installer.js";
import { codexInstaller } from "./codex-installer.js";
import { cursorInstaller } from "./cursor-installer.js";
import { windsurfInstaller } from "./windsurf-installer.js";
import type { ClientInstaller } from "./types.js";

export const INSTALLERS: Record<AiClientNotNull, ClientInstaller> = {
  "claude-code": claudeInstaller,
  cursor: cursorInstaller,
  codex: codexInstaller,
  windsurf: windsurfInstaller,
};

type AiClientNotNull = AgentTargetId;

export function getInstaller(id: AgentTargetId): ClientInstaller {
  return INSTALLERS[id];
}

export type { ClientInstaller, InjectResult, RemoveResult } from "./types.js";
export { PATHRULE_SERVER_KEY } from "./types.js";
