// SPDX-License-Identifier: Apache-2.0
// @pathrule/core — the open, backend-agnostic knowledge layer.
//
// This barrel is the package's PUBLIC API: the backend seam (the interface +
// its capability flags + the I/O contract types), the two shipped backends
// (the embedded-SQLite LocalBackend and the dependency-light InMemory reference,
// which third-party backend authors can use as a behavioral template), and the
// local principal resolver. Storage internals (the SQLite schema/migrations), the
// identity fallback constant, and the bring-your-own-embedding adapter are
// intentionally NOT re-exported — they are implementation details reachable
// internally by relative import, and exporting them would lock them into the
// package's compatibility surface.

export type { BackendCapabilities } from "./backend/capabilities.js";
export type { KnowledgeBackend } from "./backend/knowledge-backend.js";
export type * from "./backend/inputs.js";
// Native Knowledge Compilation: the per-directory payload type referenced by
// KnowledgeBackend.buildKnowledgePayload, plus the pure assembler itself —
// exported so every backend (including the closed CloudBackend and any
// third-party backend) compiles knowledge identically from its own store.
export type {
  AssembleKnowledgeOptions,
  CompiledKnowledgeNode,
  KnowledgeRenderMode,
} from "./backend/knowledge-compiler.js";
export { assembleKnowledgeNodes } from "./backend/knowledge-compiler.js";
export type { HookIndexInput } from "./backend/hook-index.js";
// The deterministic hook-index + full-body warehouse assemblers, so an offline
// runtime (and the benchmark harness) can build exactly what the supervisor reads.
export { assembleHookIndex, assembleWarehouse } from "./backend/hook-index.js";
// BYO embedding helpers — exposed so the benchmark harness can precompute a
// fixture's embeddings.json (the same vectors the hook ranks against).
export { embedTextBYO, hasEmbeddingKey } from "./backend/embedding-adapter.js";
export { composeEmbeddingText, cosineSimilarity } from "./backend/semantic-rank.js";
export { InMemoryKnowledgeBackend } from "./backend/in-memory-backend.js";
export type { InMemoryBackendOptions } from "./backend/in-memory-backend.js";
export { LocalBackend } from "./backend/local/local-backend.js";
export type { LocalBackendOptions } from "./backend/local/local-backend.js";
// The local principal resolver, so the local MCP server composition can stamp
// ctx.userId without re-deriving the OS-username logic.
export { resolveLocalPrincipal } from "./backend/local/identity.js";
