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
export { InMemoryKnowledgeBackend } from "./backend/in-memory-backend.js";
export type { InMemoryBackendOptions } from "./backend/in-memory-backend.js";
export { LocalBackend } from "./backend/local/local-backend.js";
export type { LocalBackendOptions } from "./backend/local/local-backend.js";
// The local principal resolver, so the local MCP server composition can stamp
// ctx.userId without re-deriving the OS-username logic.
export { resolveLocalPrincipal } from "./backend/local/identity.js";
