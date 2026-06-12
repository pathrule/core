export type CompanionPayloadMode = "slim";

export type InjectionSurface = "session_start" | "prompt" | "pre_tool" | "post_tool" | "mcp";

export type ContextImportance = "always" | "path_scoped" | "intent_scoped" | "on_demand";

export interface ContextDeliveryRule {
  surface: InjectionSurface;
  importance: ContextImportance;
  description: string;
}

export interface ContextDeliveryPolicy {
  companionPayloadMode: CompanionPayloadMode;
  rules: ContextDeliveryRule[];
}

export const DEFAULT_CONTEXT_DELIVERY_POLICY: ContextDeliveryPolicy = {
  companionPayloadMode: "slim",
  rules: [
    {
      surface: "session_start",
      importance: "always",
      description:
        "Inject workspace identity and recent session orientation without broad project-rule dumps.",
    },
    {
      surface: "pre_tool",
      importance: "path_scoped",
      description: "Inject relevant path-scoped memory and rule previews before file work.",
    },
    {
      surface: "prompt",
      importance: "intent_scoped",
      description: "Inline filename or skill matches only when the prompt gives a clear signal.",
    },
    {
      surface: "mcp",
      importance: "on_demand",
      description: "Fetch routed context or full bodies only when hook context is not enough.",
    },
  ],
};
