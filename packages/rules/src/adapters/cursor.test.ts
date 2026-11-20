import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { CursorRuleAdapter } from "./cursor.js";
import type { RuleDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-rules-cursor-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("CursorRuleAdapter", () => {
  let adapter: CursorRuleAdapter;

  const testRule: RuleDefinition = {
    id: "typescript",
    name: "TypeScript Standards",
    description: "TypeScript coding standards",
    content: "Always use strict TypeScript.",
    scope: { type: "glob", patterns: ["*.ts", "*.tsx"] },
  };

  const alwaysRule: RuleDefinition = {
    id: "general",
    name: "General",
    description: "General rules",
    content: "Be concise.",
    scope: { type: "always" },
  };

  const manualRule: RuleDefinition = {
    id: "manual",
    name: "Manual Rule",
    description: "A manual rule",
    content: "Invoke when needed.",
    scope: { type: "manual" },
  };

  beforeEach(() => {
    adapter = new CursorRuleAdapter();
  });

  describe("metadata", () => {
    it("has correct id", () => expect(adapter.id).toBe("cursor"));
    it("has correct name", () => expect(adapter.name).toBe("Cursor"));
    it("has correct configDir", () => expect(adapter.configDir).toBe(".cursor/rules"));
    it("has nativeSupport true", () => expect(adapter.nativeSupport).toBe(true));
  });

  describe("generate", () => {
    it("uses flat *.mdc files Cursor actually loads", async () => {
      const files = await adapter.generate([testRule]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".cursor/rules/typescript.mdc");
      expect(files[0]?.format).toBe("md");
    });

    it("includes frontmatter with alwaysApply false for glob scope", async () => {
      const files = await adapter.generate([testRule]);
      expect(files[0]?.content).toContain("alwaysApply: false");
      expect(files[0]?.content).toContain('- "*.ts"');
    });

    it("includes alwaysApply true for always scope", async () => {
      const files = await adapter.generate([alwaysRule]);
      expect(files[0]?.content).toContain("alwaysApply: true");
    });

    it("includes alwaysApply false for manual scope", async () => {
      const files = await adapter.generate([manualRule]);
      expect(files[0]?.content).toContain("alwaysApply: false");
      expect(files[0]?.content).not.toContain("globs:");
    });

    it("generates rule without description", async () => {
      const noDescRule: RuleDefinition = {
        id: "nodesc",
        name: "No Description",
        content: "Content only.",
        scope: { type: "always" },
      };
      const files = await adapter.generate([noDescRule]);
      expect(files[0]?.content).not.toContain("description:");
      expect(files[0]?.content).toContain("alwaysApply: true");
      expect(files[0]?.content).toContain("Content only.");
    });

    it("handles empty rules array", async () => {
      const files = await adapter.generate([]);
      expect(files).toHaveLength(0);
    });

    it("generates multiple flat mdc files for multiple rules", async () => {
      const files = await adapter.generate([testRule, alwaysRule]);
      expect(files).toHaveLength(2);
      expect(files[0]?.path).toBe(".cursor/rules/typescript.mdc");
      expect(files[1]?.path).toBe(".cursor/rules/general.mdc");
    });
  });

  describe("install & uninstall", () => {
    it("writes flat .mdc files and uninstall removes .cursor/rules", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testRule, alwaysRule]);
        await adapter.install(files, dir);

        const mdcPath = join(dir, ".cursor/rules/typescript.mdc");
        expect(existsSync(mdcPath)).toBe(true);
        expect(existsSync(join(dir, ".cursor/rules/general.mdc"))).toBe(true);
        expect(existsSync(join(dir, ".cursor/rules/typescript/RULE.md"))).toBe(false);
        expect(await readFile(mdcPath, "utf-8")).toContain("alwaysApply: false");

        await adapter.uninstall(dir);
        expect(existsSync(join(dir, ".cursor/rules"))).toBe(false);
      });
    });

    it("uninstall is a no-op when .cursor/rules does not exist", async () => {
      await withTempDir(async (dir) => {
        await expect(adapter.uninstall(dir)).resolves.toBeUndefined();
      });
    });
  });

  describe("import", () => {
    it("returns empty when dir missing", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(join(dir, "missing"))).toEqual([]);
      });
    });

    it("imports rules from flat .mdc files with YAML list globs", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".cursor/rules"), { recursive: true });
        await writeFile(
          join(dir, ".cursor/rules/typescript.mdc"),
          '---\ndescription: TS rules\nalwaysApply: false\nglobs:\n  - "*.ts"\n---\n\nUse strict TS.',
        );

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("typescript");
        expect(result[0]?.description).toBe("TS rules");
        expect(result[0]?.scope).toEqual({ type: "glob", patterns: ["*.ts"] });
        expect(result[0]?.content).toBe("Use strict TS.");
      });
    });

    it("parses CRLF line endings and single-line, comma-separated, and inline array globs", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".cursor/rules"), { recursive: true });
        await writeFile(
          join(dir, ".cursor/rules/single.mdc"),
          "---\r\ndescription: Single glob\r\nglobs: src/**/*.ts\r\nalwaysApply: false\r\n---\r\n\r\nSingle body.\r\n",
        );
        await writeFile(
          join(dir, ".cursor/rules/comma.mdc"),
          "---\r\ndescription: Comma globs\r\nglobs: *.ts, *.tsx\r\nalwaysApply: false\r\n---\r\n\r\nComma body.\r\n",
        );
        await writeFile(
          join(dir, ".cursor/rules/inline-array.mdc"),
          '---\r\ndescription: Array globs\r\nglobs: ["*.ts", "src/**/*.tsx"]\r\nalwaysApply: false\r\n---\r\n\r\nArray body.\r\n',
        );

        const result = await adapter.import(dir);
        const byId = new Map(result.map((r) => [r.id, r]));

        expect(byId.get("single")?.scope).toEqual({ type: "glob", patterns: ["src/**/*.ts"] });
        expect(byId.get("single")?.content).toBe("Single body.");
        expect(byId.get("comma")?.scope).toEqual({ type: "glob", patterns: ["*.ts", "*.tsx"] });
        expect(byId.get("comma")?.content).toBe("Comma body.");
        expect(byId.get("inline-array")?.scope).toEqual({
          type: "glob",
          patterns: ["*.ts", "src/**/*.tsx"],
        });
        expect(byId.get("inline-array")?.content).toBe("Array body.");
      });
    });

    it("scans .cursor/rules/**/*.mdc recursively", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".cursor/rules/frontend/react"), { recursive: true });
        await writeFile(
          join(dir, ".cursor/rules/frontend/react/hooks.mdc"),
          "---\ndescription: React hooks\nalwaysApply: true\n---\n\nFollow rules of hooks.\n",
        );

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("frontend/react/hooks");
        expect(result[0]?.description).toBe("React hooks");
        expect(result[0]?.scope).toEqual({ type: "always" });
        expect(result[0]?.content).toBe("Follow rules of hooks.");
      });
    });

    it("preserves body content when frontmatter is absent", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".cursor/rules"), { recursive: true });
        await writeFile(join(dir, ".cursor/rules/plain.mdc"), "Just plain content.\r\nLine two.");

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("plain");
        expect(result[0]?.content).toBe("Just plain content.\nLine two.");
        expect(result[0]?.scope).toEqual({ type: "always" });
      });
    });

    it("parses alwaysApply true as always scope and false without globs as manual scope", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".cursor/rules"), { recursive: true });
        await writeFile(
          join(dir, ".cursor/rules/general.mdc"),
          "---\ndescription: General\nalwaysApply: true\n---\n\nBe concise.",
        );
        await writeFile(
          join(dir, ".cursor/rules/manual.mdc"),
          "---\ndescription: Manual\nalwaysApply: false\n---\n\nManual rule.",
        );

        const result = await adapter.import(dir);
        const byId = new Map(result.map((r) => [r.id, r]));
        expect(byId.get("general")?.scope).toEqual({ type: "always" });
        expect(byId.get("manual")?.scope).toEqual({ type: "manual" });
      });
    });

    it("uses process.cwd() when cwd is not provided", async () => {
      await withTempDir(async (dir) => {
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
        try {
          expect(await adapter.import()).toEqual([]);
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });

    it("skips non-mdc entries including nested RULE.md leftovers", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".cursor/rules/norule"), { recursive: true });
        await writeFile(join(dir, ".cursor/rules/norule/RULE.md"), "ignored");
        await writeFile(join(dir, ".cursor/rules/readme.md"), "ignored markdown");

        const result = await adapter.import(dir);
        expect(result).toEqual([]);
      });
    });
  });
});
