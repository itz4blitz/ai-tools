import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveRepoRoot } from "../../../../scripts/sync-versions.js";

// Build forbidden patterns from fragments so this test file itself does not
// contain literal private org names or personal home paths.
const FORBIDDEN_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "private-org-1", regex: new RegExp(["palam", "health"].join(""), "i") },
  { label: "private-org-2", regex: new RegExp(["premier", "\\s*", "studio"].join(""), "i") },
  { label: "personal-home-path", regex: new RegExp(["/home/", "blitz"].join(""), "i") },
];

// Files owned by a parallel wave (Wave 0C) that will be sanitized separately.
const TEMPORARY_EXCLUSIONS = new Set([
  "packages/mcp/src/toml-mcp.ts",
  "packages/mcp/src/toml-mcp.test.ts",
]);

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (stat.isFile()) {
      results.push(full);
    }
  }
  return results;
}

describe("repository OSS privacy hygiene", () => {
  it("contains no private organization names or personal home paths under packages/", () => {
    const repoRoot = resolveRepoRoot();
    const packagesDir = join(repoRoot, "packages");
    const violations: string[] = [];

    for (const filePath of walkFiles(packagesDir)) {
      const rel = relative(repoRoot, filePath).replaceAll("\\", "/");
      if (TEMPORARY_EXCLUSIONS.has(rel)) continue;

      const content = readFileSync(filePath, "utf-8");
      for (const { label, regex } of FORBIDDEN_PATTERNS) {
        if (regex.test(content)) {
          violations.push(`${rel} matched ${label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
