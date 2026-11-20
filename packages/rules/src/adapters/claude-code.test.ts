import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeRuleAdapter } from "./claude-code.js";
import type { RuleDefinition } from "../types/index.js";

const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-rules-claude-"));
  temps.push(dir);
  return dir;
}

describe("ClaudeCodeRuleAdapter", () => {
  let adapter: ClaudeCodeRuleAdapter;

  const testRule: RuleDefinition = {
    id: "typescript",
    name: "TypeScript Standards",
    description: "TypeScript coding standards",
    content: "Always use strict TypeScript.\nNo any types.",
    scope: { type: "glob", patterns: ["*.ts", "*.tsx"] },
  };

  const alwaysRule: RuleDefinition = {
    id: "general",
    name: "General",
    description: "General rules",
    content: "Be concise.",
    scope: { type: "always" },
  };

  beforeEach(() => {
    adapter = new ClaudeCodeRuleAdapter();
  });

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe("metadata", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("claude-code");
      expect(adapter.name).toBe("Claude Code");
      expect(adapter.configDir).toBe(".claude/rules");
      expect(adapter.nativeSupport).toBe(true);
    });
  });

  describe("generate & roundtrip", () => {
    it("emits paths: (not globs:) in frontmatter and roundtrips on disk", async () => {
      const dir = await tempDir();
      const files = await adapter.generate([testRule, alwaysRule]);
      expect(files).toHaveLength(2);
      expect(files[0]!.content).toContain("paths:\n");
      expect(files[0]!.content).not.toContain("globs:");
      expect(files[0]!.content).toContain('  - "*.ts"');
      expect(files[1]!.content).not.toContain("paths:");

      await adapter.install(files, dir);
      const imported = await adapter.import(dir);
      expect(imported).toHaveLength(2);

      const ts = imported.find((r) => r.id === "typescript");
      expect(ts).toBeDefined();
      expect(ts!.description).toBe("TypeScript coding standards");
      expect(ts!.scope).toEqual({ type: "glob", patterns: ["*.ts", "*.tsx"] });
      expect(ts!.content).toBe("Always use strict TypeScript.\nNo any types.");

      const general = imported.find((r) => r.id === "general");
      expect(general).toBeDefined();
      expect(general!.scope).toEqual({ type: "always" });
      expect(general!.content).toBe("Be concise.");
    });

    it("accepts legacy globs:, scopes list items to active key, normalizes CRLF, and scans subdirectories recursively", async () => {
      const dir = await tempDir();
      const nestedDir = join(dir, ".claude", "rules", "frontend");
      await mkdir(nestedDir, { recursive: true });

      await writeFile(
        join(dir, ".claude", "rules", "legacy.md"),
        '---\r\ndescription: Legacy rule\r\ntags:\r\n  - ignored-tag\r\nglobs:\r\n  - "src/**/*.ts"\r\n---\r\n\r\nLegacy body.\r\n',
        "utf-8",
      );
      await writeFile(
        join(nestedDir, "react.md"),
        '---\r\ndescription: React rule\r\npaths:\r\n  - "**/*.tsx"\r\n---\r\n\r\nUse hooks.\r\n',
        "utf-8",
      );
      await writeFile(join(nestedDir, "notes.txt"), "ignore me", "utf-8");

      const imported = await adapter.import(dir);
      expect(imported).toHaveLength(2);

      const legacy = imported.find((r) => r.id === "legacy");
      expect(legacy).toBeDefined();
      expect(legacy!.scope).toEqual({ type: "glob", patterns: ["src/**/*.ts"] });
      expect(legacy!.content).toBe("Legacy body.");

      const react = imported.find((r) => r.id === "frontend/react");
      expect(react).toBeDefined();
      expect(react!.description).toBe("React rule");
      expect(react!.scope).toEqual({ type: "glob", patterns: ["**/*.tsx"] });
      expect(react!.content).toBe("Use hooks.");
    });

    it("uninstall removes .claude/rules directory", async () => {
      const dir = await tempDir();
      await adapter.install(await adapter.generate([testRule]), dir);
      expect(existsSync(join(dir, ".claude/rules/typescript.md"))).toBe(true);

      await adapter.uninstall(dir);
      expect(existsSync(join(dir, ".claude/rules"))).toBe(false);
    });
  });
});
