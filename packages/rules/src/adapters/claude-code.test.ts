import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], callback: (error: Error | null) => void) => {
    callback(new Error("not found"));
  }),
}));

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { ClaudeCodeRuleAdapter } from "./claude-code.js";
import type { RuleDefinition } from "../types/index.js";

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
    vi.clearAllMocks();
    adapter = new ClaudeCodeRuleAdapter();
  });

  describe("metadata", () => {
    it("has correct id", () => expect(adapter.id).toBe("claude-code"));
    it("has correct name", () => expect(adapter.name).toBe("Claude Code"));
    it("has correct configDir", () => expect(adapter.configDir).toBe(".claude/rules"));
    it("has nativeSupport true", () => expect(adapter.nativeSupport).toBe(true));
  });

  describe("generate", () => {
    it("generates one file per rule", async () => {
      const files = await adapter.generate([testRule]);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe(".claude/rules/typescript.md");
      expect(files[0].format).toBe("md");
    });

    it("includes frontmatter with description and globs", async () => {
      const files = await adapter.generate([testRule]);
      expect(files[0].content).toContain("---");
      expect(files[0].content).toContain("description: TypeScript coding standards");
      expect(files[0].content).toContain('- "*.ts"');
      expect(files[0].content).toContain('- "*.tsx"');
    });

    it("includes rule content after frontmatter", async () => {
      const files = await adapter.generate([testRule]);
      expect(files[0].content).toContain("Always use strict TypeScript.");
      expect(files[0].content).toContain("No any types.");
    });

    it("handles always scope without globs", async () => {
      const files = await adapter.generate([alwaysRule]);
      expect(files[0].content).toContain("description: General rules");
      expect(files[0].content).not.toContain("globs:");
    });

    it("generates rule without description", async () => {
      const noDescRule: RuleDefinition = {
        id: "nodesc",
        name: "No Description",
        content: "Content only.",
        scope: { type: "always" },
      };
      const files = await adapter.generate([noDescRule]);
      expect(files[0].content).not.toContain("description:");
      expect(files[0].content).toContain("Content only.");
    });

    it("generates rule with glob scope patterns", async () => {
      const files = await adapter.generate([testRule]);
      expect(files[0].content).toContain("globs:");
      expect(files[0].content).toContain('- "*.ts"');
      expect(files[0].content).toContain('- "*.tsx"');
    });

    it("handles empty rules array", async () => {
      const files = await adapter.generate([]);
      expect(files).toHaveLength(0);
    });

    it("generates multiple files for multiple rules", async () => {
      const files = await adapter.generate([testRule, alwaysRule]);
      expect(files).toHaveLength(2);
      expect(files[0].path).toBe(".claude/rules/typescript.md");
      expect(files[1].path).toBe(".claude/rules/general.md");
    });
  });

  describe("import", () => {
    it("returns empty when dir missing", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const result = await adapter.import("/test");
      expect(result).toEqual([]);
    });

    it("imports rules with frontmatter", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdir).mockResolvedValue(["ts.md"] as never);
      vi.mocked(readFile).mockResolvedValue(
        '---\ndescription: TS rules\nglobs:\n  - "*.ts"\n---\n\nUse strict TS.',
      );
      const result = await adapter.import("/test");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("ts");
      expect(result[0].description).toBe("TS rules");
      expect(result[0].scope).toEqual({ type: "glob", patterns: ["*.ts"] });
      expect(result[0].content).toBe("Use strict TS.");
    });

    it("imports rules without frontmatter", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdir).mockResolvedValue(["simple.md"] as never);
      vi.mocked(readFile).mockResolvedValue("Just plain content.");
      const result = await adapter.import("/test");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("simple");
      expect(result[0].content).toBe("Just plain content.");
      expect(result[0].scope).toEqual({ type: "always" });
    });

    it("uses process.cwd() when cwd is not provided", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const result = await adapter.import();
      expect(result).toEqual([]);
    });

    it("imports rules with frontmatter but no globs", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdir).mockResolvedValue(["general.md"] as never);
      vi.mocked(readFile).mockResolvedValue("---\ndescription: General rules\n---\n\nBe concise.");
      const result = await adapter.import("/test");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("general");
      expect(result[0].description).toBe("General rules");
      expect(result[0].scope).toEqual({ type: "always" });
      expect(result[0].content).toBe("Be concise.");
    });

    it("skips non-md files", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdir).mockResolvedValue(["readme.txt", "rule.md"] as never);
      vi.mocked(readFile).mockResolvedValue("Content");
      const result = await adapter.import("/test");
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("rule");
    });
  });

  describe("detect", () => {
    it("returns true when configDir exists", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      expect(await adapter.detect("/test")).toBe(true);
    });

    it("returns false when configDir missing and command not found", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(await adapter.detect("/test")).toBe(false);
    });

    it("returns true when configDir missing but command exists", async () => {
      const { execFile } = await import("node:child_process");
      vi.mocked(execFile).mockImplementation((_cmd: unknown, _args: unknown, callback: unknown) => {
        (callback as (error: Error | null) => void)(null);
        return undefined as never;
      });
      vi.mocked(existsSync).mockReturnValue(false);
      expect(await adapter.detect("/test")).toBe(true);
    });
  });
});
