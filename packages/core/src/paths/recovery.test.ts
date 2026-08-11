import { describe, expect, it } from "vitest";
import { buildRecoveryPlan, restoredBody, type ScannedFile } from "./recovery.js";
import { spliceRegion } from "./region.js";

const KNOWLEDGE_BANNER = "<!-- Pathrule managed (knowledge): do not edit. -->";

const file = (path: string, content: string): ScannedFile => ({ path, content });

describe("buildRecoveryPlan", () => {
  it("finds a stray backup left next to the file it was taken from", () => {
    const plan = buildRecoveryPlan([
      file("packages/api/backup.CLAUDE.md", "# API package\n\nNode 20 only.\n"),
      file("packages/api/CLAUDE.md", `${KNOWLEDGE_BANNER}\n# Project knowledge\n`),
    ]);

    expect(plan.leftovers).toHaveLength(1);
    expect(plan.leftovers[0]).toMatchObject({
      kind: "stray_backup",
      path: "packages/api/backup.CLAUDE.md",
      restoresTo: "packages/api/CLAUDE.md",
      liveFileIsPathruleOnly: true,
      preview: "# API package",
    });
    expect(plan.restorable).toHaveLength(1);
    expect(plan.needsChoice).toEqual([]);
  });

  it("recognises numbered collisions and the malformed dotfile name", () => {
    const plan = buildRecoveryPlan([
      file("backup.CLAUDE.md", "v1\n"),
      file("backup.CLAUDE.md.1", "v2\n"),
      file("backup.CLAUDE.md.6", "v7\n"),
      file("backup..cursorrules", "strict mode\n"),
    ]);

    expect(plan.leftovers.map((l) => l.restoresTo)).toEqual([
      ".cursorrules",
      "CLAUDE.md",
      "CLAUDE.md",
      "CLAUDE.md",
    ]);
  });

  it("finds vault backups from the interim layout", () => {
    const plan = buildRecoveryPlan([
      file(".pathrule/backups/AGENTS.md", "# Team\n\nRun pnpm test.\n"),
      file(".pathrule/backups/packages/web/CLAUDE.md", "# Web\n\nReact 19.\n"),
    ]);

    expect(plan.leftovers.map((l) => [l.kind, l.restoresTo])).toEqual([
      ["vault_backup", "AGENTS.md"],
      ["vault_backup", "packages/web/CLAUDE.md"],
    ]);
  });

  it("flags a leftover as needing a choice when the live file has user content", () => {
    const live = spliceRegion("# Team rules\n\nUse pnpm.\n", "PATHRULE SECTION");
    const plan = buildRecoveryPlan([
      file("backup.CLAUDE.md", "# Old team rules\n\nUse npm.\n"),
      file("CLAUDE.md", live),
    ]);

    expect(plan.needsChoice).toHaveLength(1);
    expect(plan.restorable).toEqual([]);
    expect(plan.needsChoice[0]!.liveFileIsPathruleOnly).toBe(false);
  });

  it("treats a region-only live file as safe to restore over", () => {
    const live = spliceRegion("", "PATHRULE SECTION");
    const plan = buildRecoveryPlan([file("backup.AGENTS.md", "# Team\n"), file("AGENTS.md", live)]);
    expect(plan.restorable).toHaveLength(1);
  });

  it("treats a missing live file as safe to restore", () => {
    const plan = buildRecoveryPlan([file("backup.AGENTS.md", "# Team\n")]);
    expect(plan.restorable).toHaveLength(1);
    expect(plan.restorable[0]!.liveFileIsPathruleOnly).toBe(true);
  });

  it("ignores files that only look like backups", () => {
    const plan = buildRecoveryPlan([
      file("backup.README.md", "not an instruction file\n"),
      file("docs/backup.notes.md", "nope\n"),
      file("scripts/backup.sh", "nope\n"),
      file("CLAUDE.md", "# mine\n"),
      file(".pathrule/managed-files.json", "{}\n"),
      file(".pathrule/backups/notes.txt", "nope\n"),
    ]);
    expect(plan.leftovers).toEqual([]);
  });

  it("returns an empty plan for a clean repo", () => {
    expect(buildRecoveryPlan([]).leftovers).toEqual([]);
    expect(buildRecoveryPlan([file("CLAUDE.md", "# mine\n")]).leftovers).toEqual([]);
  });
});

describe("restoredBody", () => {
  it("gives back the user's bytes with a single trailing newline", () => {
    const plan = buildRecoveryPlan([file("backup.CLAUDE.md", "# mine\n\n\n")]);
    expect(restoredBody(plan.leftovers[0]!, "# mine\n\n\n")).toBe("# mine\n");
  });

  it("refuses to guess when the live file has user content", () => {
    const live = spliceRegion("# theirs\n", "SECTION");
    const plan = buildRecoveryPlan([file("backup.CLAUDE.md", "# mine\n"), file("CLAUDE.md", live)]);
    expect(restoredBody(plan.leftovers[0]!, "# mine\n")).toBeNull();
  });
});
