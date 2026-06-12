// CLI-side hook script materializer.
//
// The desktop app copies pathrule-hook.js from its resources into
// ~/.pathrule/bin/. CLI-only users never run that code, so on machines that
// installed Pathrule via npm the hook script would otherwise be missing.
// This module ships the hook script source as a build-time embedded constant
// and writes it on every `pathrule sync`.
//
// Windows invocation contract (chosen here):
//   - We DO NOT register the bare .js path as the hook command. AI clients
//     that spawn hooks without a shell (Codex on Windows) cannot execute a
//     .js file directly.
//   - We DO write a `.cmd` shim next to the .js file. The shim is
//     `@node "%~dp0pathrule-hook.js" %*`, which is the standard npm-style
//     wrapper and is directly executable by spawn-without-shell callers.
//   - setHookCommand receives the .cmd path on Windows, the .js path on
//     POSIX.
//
// The chosen format is fixture-tested by hook-script-install.test.ts so a
// later refactor cannot silently fall back to a bare .js path on Windows.

import { chmod, readFile, stat } from "node:fs/promises";

import { pathruleHome } from "@pathrule/shared/local-runtime/paths.js";
import { setHookCommand } from "@pathrule/shared/hook-supervisor/hook-command.js";
import { atomicWrite } from "@pathrule/shared/local-runtime/atomic-write.js";

import { cliPlatform } from "./platform.js";

declare const __BUILD_HOOK_SCRIPT_SOURCE__: string;
declare const __BUILD_EMBED_HELPER_SOURCE__: string;

// In tests / dev / type-checking the define is not substituted; fall back
// to an empty string so we can mock or read the source from disk.
const EMBEDDED_HOOK_SCRIPT: string =
  typeof __BUILD_HOOK_SCRIPT_SOURCE__ === "string" ? __BUILD_HOOK_SCRIPT_SOURCE__ : "";
// The prompt-embedding helper the hook spawns for relevance ranking. Written
// next to the hook; if absent the hook degrades to lexical ranking.
const EMBEDDED_EMBED_HELPER: string =
  typeof __BUILD_EMBED_HELPER_SOURCE__ === "string" ? __BUILD_EMBED_HELPER_SOURCE__ : "";

const WINDOWS_CMD_SHIM = `@echo off
node "%~dp0pathrule-hook.js" %*
`;

export interface HookScriptInstallResult {
  /** Path written to disk for the .js script. */
  scriptPath: string;
  /** When on win32, path of the .cmd shim. */
  shimPath: string | null;
  /** The path registered with setHookCommand. */
  hookCommandPath: string;
  /** True when we actually wrote / rewrote the script. */
  changed: boolean;
}

export interface HookScriptInstallOptions {
  /** Override the embedded script source (tests only). */
  scriptSource?: string;
  /** Override the embedded embed-query.cjs source (tests only). */
  embedHelperSource?: string;
}

/**
 * Pure path resolver used by both the runtime installer and tests. Keeps
 * `joinPathForPlatform` consistent across the .js path, the .cmd shim,
 * and the bin dir so tests can lock the Windows shape without touching
 * the filesystem.
 */
export function resolveCliHookScriptPaths(env: NodeJS.ProcessEnv = process.env): {
  binDir: string;
  scriptPath: string;
  shimPath: string | null;
  hookCommandPath: string;
  embedHelperPath: string;
} {
  const platform = cliPlatform(env);
  const home = pathruleHome(env);
  const binDir = joinPathForPlatform(platform, home, "bin");
  const scriptPath = joinPathForPlatform(platform, binDir, "pathrule-hook.js");
  const shimPath =
    platform === "win32" ? joinPathForPlatform(platform, binDir, "pathrule-hook.cmd") : null;
  const hookCommandPath = platform === "win32" && shimPath ? shimPath : scriptPath;
  const embedHelperPath = joinPathForPlatform(platform, binDir, "embed-query.cjs");
  return { binDir, scriptPath, shimPath, hookCommandPath, embedHelperPath };
}

/**
 * Ensure the Pathrule hook script lives at PATHRULE_HOME/bin/, generate
 * a Windows shim when needed, and tell the in-process hook merger which
 * absolute path to write into AI-client config files.
 */
export async function installCliHookScript(
  env: NodeJS.ProcessEnv = process.env,
  opts: HookScriptInstallOptions = {},
): Promise<HookScriptInstallResult> {
  const { binDir, scriptPath, shimPath, hookCommandPath, embedHelperPath } =
    resolveCliHookScriptPaths(env);
  const platform = cliPlatform(env);
  const source = opts.scriptSource ?? EMBEDDED_HOOK_SCRIPT;

  if (!source || source.length === 0) {
    throw new Error(
      "Pathrule hook script source is empty. The CLI bundle did not embed " +
        "__BUILD_HOOK_SCRIPT_SOURCE__ — check tsup.config.ts and the " +
        "scripts/build-time-cli-defines.mjs loader.",
    );
  }

  // atomicWrite (via writeIfChanged) creates the parent dir, so no explicit mkdir.
  const changed = await writeIfChanged(scriptPath, source);

  // Write the embed helper next to the hook. Best-effort: an empty source (dev /
  // type-check, where the define is not substituted) just skips the write — the
  // hook then degrades to lexical ranking rather than failing the whole sync.
  const embedSource = opts.embedHelperSource ?? EMBEDDED_EMBED_HELPER;
  if (embedSource && embedSource.length > 0) {
    await writeIfChanged(embedHelperPath, embedSource);
  }
  if (platform !== "win32") {
    // Best-effort executable bit so users running the script directly get
    // a friendly error instead of "permission denied".
    try {
      await chmod(scriptPath, 0o755);
    } catch {
      /* non-fatal on filesystems that don't honor chmod */
    }
  } else if (shimPath) {
    await writeIfChanged(shimPath, WINDOWS_CMD_SHIM);
  }

  setHookCommand(hookCommandPath);

  return { scriptPath, shimPath, hookCommandPath, changed };
}

async function writeIfChanged(target: string, body: string): Promise<boolean> {
  try {
    const existing = await readFile(target, "utf8");
    if (existing === body) return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await atomicWrite(target, body);
  return true;
}

function joinPathForPlatform(platform: NodeJS.Platform, base: string, segment: string): string {
  const sep = platform === "win32" ? "\\" : "/";
  const cleanBase = base.replace(/[\\/]+$/, "");
  const cleanSegment = segment.replace(/^[\\/]+/, "");
  return `${cleanBase}${sep}${cleanSegment}`;
}

/** Exported only for tests. */
export const __WINDOWS_CMD_SHIM_FOR_TESTS = WINDOWS_CMD_SHIM;

/** Exported for tests that need to know whether the build embedded the script. */
export function getEmbeddedHookScriptSourceForTests(): string {
  return EMBEDDED_HOOK_SCRIPT;
}

/** Force the install to verify the on-disk script body once (used by sync()). */
export async function hookScriptInstallSanityProbe(scriptPath: string): Promise<boolean> {
  try {
    const info = await stat(scriptPath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
