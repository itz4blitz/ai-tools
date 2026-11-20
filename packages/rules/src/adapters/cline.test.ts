import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClineRuleAdapter } from "./cline.js";
import type { RuleDefinition } from "../types/index.js";

describe("ClineRuleAdapter", () => {
  let adapter: ClineRuleAdapter;
  let tempDir: string;

  const alwaysRule: RuleDefinition = {
    id: "typescript",
    name: "TypeScript Standards",
    content: "Always use strict TypeScript.",
    scope: { type: "always" },
  };

  const globRule: RuleDefinition = {
    id: "api-routes",
    name: "API Route Rules",
    content: "Validate every request payload with zod.",
    scope: { type: "glob", patterns: ["src/api/**/*.ts", "src/routes/**/*.ts"] },
  };

  beforeEach(async () => {
    adapter = new ClineRuleAdapter();
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-cline-rules-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct id, name, and configDir", () => {
      expect(adapter.id).toBe("cline");
      expect(adapter.name).toBe("Cline");
      expect(adapter.configDir).toBe(".clinerules");
    });
  });

  describe("generate & import roundtrip", () => {
    it("generates plain markdown for always rules and YAML paths frontmatter for glob rules", async () => {
      const files = await adapter.generate([alwaysRule, globRule]);
      expect(files).toHaveLength(2);

      const alwaysFile = files.find((f) => f.path === ".clinerules/typescript.md")!;
      expect(alwaysFile.content).toBe("# TypeScript Standards\n\nAlways use strict TypeScript.\n");

      const globFile = files.find((f) => f.path === ".clinerules/api-routes.md")!;
      expect(globFile.content).toContain('---\npaths:\n  - "src/api/**/*.ts"\n');
      expect(globFile.content).toContain("# API Route Rules");

      await adapter.install(files, tempDir);
      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(2);

      const importedGlob = imported.find((r) => r.id === "api-routes")!;
      expect(importedGlob.name).toBe("API Route Rules");
      expect(importedGlob.scope).toEqual({
        type: "glob",
        patterns: ["src/api/**/*.ts", "src/routes/**/*.ts"],
      });
      expect(importedGlob.content).toBe("Validate every request payload with zod.");

      const importedAlways = imported.find((r) => r.id === "typescript")!;
      expect(importedAlways.scope).toEqual({ type: "always" });
      expect(importedAlways.content).toBe("Always use strict TypeScript.");
    });

    it("parses inline paths array and CRLF line endings", async () => {
      const rulesDir = join(tempDir, ".clinerules");
      await mkdir(rulesDir, { recursive: true });
      await writeFile(
        join(rulesDir, "win.md"),
        '---\r\npaths: ["packages/**/*.ts", "apps/**/*.tsx"]\r\n---\r\n\r\n# Windows Rule\r\n\r\nUse LF.\r\n',
        "utf-8",
      );

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toEqual({
        id: "win",
        name: "Windows Rule",
        content: "Use LF.",
        scope: { type: "glob", patterns: ["packages/**/*.ts", "apps/**/*.tsx"] },
      });
    });

    it("returns empty array when .clinerules does not exist", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });
  });

  describe("legacy single-file .clinerules handling", () => {
    it("imports legacy single-file .clinerules without ENOTDIR", async () => {
      await writeFile(
        join(tempDir, ".clinerules"),
        "# Legacy Guidelines\r\n\r\nAlways write tests.\r\n",
        "utf-8",
      );

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toEqual({
        id: "clinerules",
        name: "Legacy Guidelines",
        content: "Always write tests.",
        scope: { type: "always" },
      });
    });

    it("migrates legacy single-file .clinerules to .clinerules/legacy.md on install", async () => {
      await writeFile(
        join(tempDir, ".clinerules"),
        "# Legacy Guidelines\n\nKeep existing rules.\n",
        "utf-8",
      );

      const files = await adapter.generate([alwaysRule]);
      await adapter.install(files, tempDir);

      expect(existsSync(join(tempDir, ".clinerules", "typescript.md"))).toBe(true);
      expect(existsSync(join(tempDir, ".clinerules", "legacy.md"))).toBe(true);
      expect(await readFile(join(tempDir, ".clinerules", "legacy.md"), "utf-8")).toContain(
        "Keep existing rules.",
      );
    });
  });

  describe("uninstall", () => {
    it("removes .clinerules/*.md while preserving hooks/ and workflows/ subdirectories", async () => {
      const files = await adapter.generate([alwaysRule]);
      await adapter.install(files, tempDir);

      await mkdir(join(tempDir, ".clinerules", "hooks"), { recursive: true });
      await writeFile(join(tempDir, ".clinerules", "hooks", "PreToolUse"), "#!/usr/bin/env node\n");
      await mkdir(join(tempDir, ".clinerules", "workflows"), { recursive: true });
      await writeFile(join(tempDir, ".clinerules", "workflows", "deploy.md"), "# Deploy\n");

      await adapter.uninstall(tempDir);

      expect(existsSync(join(tempDir, ".clinerules", "typescript.md"))).toBe(false);
      expect(existsSync(join(tempDir, ".clinerules", "hooks", "PreToolUse"))).toBe(true);
      expect(existsSync(join(tempDir, ".clinerules", "workflows", "deploy.md"))).toBe(true);
    });
  });
});
