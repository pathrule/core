// SPDX-License-Identifier: Apache-2.0
// The CLI's own version, read once from package.json. Lives at the src root so the
// `../package.json` path resolves correctly in BOTH modes: from src/cli-version.ts
// in tests, and from the bundled dist/index.js at runtime (everything bundles into
// one file there, so `import.meta.url` is the dist file and `../` lands on the
// package root). Deeper modules (e.g. src/local/*) must import this rather than
// reaching for `../../package.json`, whose depth only resolves in source, not the bundle.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const CLI_VERSION = (require("../package.json") as { version: string }).version;
