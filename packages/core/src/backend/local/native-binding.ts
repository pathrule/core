// SPDX-License-Identifier: Apache-2.0
// Optional better-sqlite3 native-binding override. Hosts that VENDOR
// prebuilt binaries for several runtimes/ABIs (e.g. an editor extension that
// runs both inside an Electron host and under the user's system Node) set
// PATHRULE_SQLITE_NATIVE_DIR to a directory of binaries named
// `<runtime>-v<abi>.node` (node-v115.node, electron-v133.node, ...).
// Each process picks the binary matching its OWN runtime at load time.
// When the variable is unset, or no matching file exists, better-sqlite3's
// default resolution (node_modules build/prebuild) is used unchanged.

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeVersions {
  /** process.versions.modules — the ABI number. */
  modules: string | undefined;
  /** process.versions.electron — set only inside Electron. */
  electron?: string | undefined;
}

/** Pure resolver (injectable fs/versions for tests). */
export function resolveSqliteNativeBinding(
  env: NodeJS.ProcessEnv = process.env,
  versions: RuntimeVersions = process.versions,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const dir = env.PATHRULE_SQLITE_NATIVE_DIR?.trim();
  if (!dir || !versions.modules) return undefined;
  const runtime = versions.electron ? "electron" : "node";
  const candidate = join(dir, `${runtime}-v${versions.modules}.node`);
  return exists(candidate) ? candidate : undefined;
}
