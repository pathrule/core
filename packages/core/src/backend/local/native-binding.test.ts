// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { resolveSqliteNativeBinding } from "./native-binding.js";

describe("resolveSqliteNativeBinding", () => {
  const exists = (hit: string) => (p: string) => p === hit;

  it("returns undefined when the env var is unset", () => {
    expect(resolveSqliteNativeBinding({}, { modules: "115" })).toBeUndefined();
  });

  it("picks node-v<abi>.node under plain node", () => {
    const path = resolveSqliteNativeBinding(
      { PATHRULE_SQLITE_NATIVE_DIR: "/vendored" },
      { modules: "115" },
      exists("/vendored/node-v115.node"),
    );
    expect(path).toBe("/vendored/node-v115.node");
  });

  it("picks electron-v<abi>.node inside an electron host", () => {
    const path = resolveSqliteNativeBinding(
      { PATHRULE_SQLITE_NATIVE_DIR: "/vendored" },
      { modules: "133", electron: "35.0.0" },
      exists("/vendored/electron-v133.node"),
    );
    expect(path).toBe("/vendored/electron-v133.node");
  });

  it("falls back to default loading when no matching binary exists", () => {
    expect(
      resolveSqliteNativeBinding(
        { PATHRULE_SQLITE_NATIVE_DIR: "/vendored" },
        { modules: "999" },
        () => false,
      ),
    ).toBeUndefined();
  });
});
