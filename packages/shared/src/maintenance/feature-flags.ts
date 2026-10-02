export const MAINTENANCE_CAPABILITIES = [
  "materializer",
  "newUi",
  "deterministicApply",
  "pathruleAi",
  "userEngine",
  // In-flow knowledge gap lines (hook, get_context, Studio). Off until a labelled
  // precision run on real gaps reaches 0.70; gap cases reach Knowledge Maintenance regardless.
  "knowledgeGapDelivery",
] as const;

export type MaintenanceCapability = (typeof MAINTENANCE_CAPABILITIES)[number];

export type MaintenanceFeatureFlags = Record<MaintenanceCapability, boolean>;

export const DEFAULT_MAINTENANCE_FEATURE_FLAGS: Readonly<MaintenanceFeatureFlags> = {
  materializer: true,
  newUi: true,
  deterministicApply: true,
  pathruleAi: true,
  userEngine: true,
  knowledgeGapDelivery: false,
};

export const MAINTENANCE_ENV_KEYS: Readonly<Record<MaintenanceCapability, string>> = {
  materializer: "PATHRULE_MAINTENANCE_MATERIALIZER_ENABLED",
  newUi: "PATHRULE_MAINTENANCE_UI_ENABLED",
  deterministicApply: "PATHRULE_MAINTENANCE_APPLY_ENABLED",
  pathruleAi: "PATHRULE_MAINTENANCE_PATHRULE_AI_ENABLED",
  userEngine: "PATHRULE_MAINTENANCE_USER_ENGINE_ENABLED",
  knowledgeGapDelivery: "PATHRULE_MAINTENANCE_KNOWLEDGE_GAP_DELIVERY_ENABLED",
};

const DEPENDENCIES: Readonly<Record<MaintenanceCapability, readonly MaintenanceCapability[]>> = {
  materializer: [],
  newUi: ["materializer"],
  deterministicApply: ["materializer", "newUi"],
  pathruleAi: ["materializer", "newUi"],
  userEngine: ["materializer", "newUi"],
  knowledgeGapDelivery: ["materializer"],
};

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return undefined;
}

/**
 * Resolve raw flags without silently enabling dependencies. A capability whose
 * prerequisite is disabled resolves to false, even if its own env flag is true.
 */
export function resolveMaintenanceFeatureFlags(input?: {
  defaults?: Partial<MaintenanceFeatureFlags>;
  env?: Readonly<Record<string, string | undefined>>;
  overrides?: Partial<MaintenanceFeatureFlags>;
}): MaintenanceFeatureFlags {
  const raw = { ...DEFAULT_MAINTENANCE_FEATURE_FLAGS, ...input?.defaults };

  for (const capability of MAINTENANCE_CAPABILITIES) {
    const fromEnv = parseBoolean(input?.env?.[MAINTENANCE_ENV_KEYS[capability]]);
    if (fromEnv != null) raw[capability] = fromEnv;
  }

  Object.assign(raw, input?.overrides);

  const resolved = { ...raw };
  for (const capability of MAINTENANCE_CAPABILITIES) {
    if (DEPENDENCIES[capability].some((dependency) => !resolved[dependency])) {
      resolved[capability] = false;
    }
  }
  return resolved;
}

export function isMaintenanceCapabilityEnabled(
  flags: MaintenanceFeatureFlags,
  capability: MaintenanceCapability,
): boolean {
  return flags[capability] && DEPENDENCIES[capability].every((dependency) => flags[dependency]);
}
