import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveRepoRoot, syncWorkspaceVersions } from "../../../../scripts/sync-versions.js";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

describe("syncWorkspaceVersions", () => {
  it("pins exact @itz4blitz dependency versions to the release version", () => {
    const root = mkdtempSync(join(tmpdir(), "sync-versions-"));
    mkdirSync(join(root, "packages", "cli"), { recursive: true });
    mkdirSync(join(root, "packages", "agents"), { recursive: true });
    writeJson(join(root, "package.json"), { name: "root", version: "1.1.8" });
    writeJson(join(root, "packages", "agents", "package.json"), {
      name: "@itz4blitz/ai-tools-agents",
      version: "1.1.8",
    });
    writeJson(join(root, "packages", "cli", "package.json"), {
      name: "@itz4blitz/ai-tools",
      version: "1.1.8",
      dependencies: { "@itz4blitz/ai-tools-agents": "1.1.8" },
    });

    syncWorkspaceVersions(root, "1.1.9");

    expect(
      JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8")),
    ).toMatchObject({
      version: "1.1.9",
      dependencies: { "@itz4blitz/ai-tools-agents": "1.1.9" },
    });
    expect(
      JSON.parse(readFileSync(join(root, "packages", "agents", "package.json"), "utf8")).version,
    ).toBe("1.1.9");
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves repo root cleanly across platforms without a leading slash on Windows", () => {
    const repoRoot = resolveRepoRoot();
    expect(existsSync(join(repoRoot, "package.json"))).toBe(true);
    if (process.platform === "win32") {
      expect(repoRoot).not.toMatch(/^\/[A-Za-z]:/);
    }
  });
});
