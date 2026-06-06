// SPDX-License-Identifier: Apache-2.0
// One shared atomic-write/read pair for the local runtime, so the CLI's
// install/sync/hook-script writers don't each re-declare it (they previously had
// byte-identical private copies). Tmp files use a per-process, per-call unique
// suffix so two concurrent writers to the same target can't clobber a shared
// `${target}.tmp` mid-write; the rename itself is atomic.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let tmpCounter = 0;

export async function atomicWrite(target: string, body: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  // Unique per process + per call — never a fixed `${target}.tmp` two writers share.
  const tmp = `${target}.${process.pid}.${(tmpCounter += 1)}.tmp`;
  try {
    await writeFile(tmp, body, "utf8");
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {}); // best-effort temp cleanup
    throw err;
  }
}

export async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
