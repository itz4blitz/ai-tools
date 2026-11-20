import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({ registry: { register: vi.fn() } }));

import { RooCodeRuleAdapter } from "./roo-code.js";
import type { RuleDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-rules-roo-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("RooCodeRuleAdapter", () => {
  let adapter: RooCodeRuleAdapter;

  beforeEach(() => {
    adapter = new RooCodeRuleAdapter();
  });

  describe("metadata", () => {
    it("has correct id", () => expect(adapter.id).toBe("roo-code"));
    it("has correct name", () => expect(adapter.name).toBe("Roo Code"));
    it("has native support", () => expect(adapter.nativeSupport).toBe(true));
    it("has correct configDir", () => expect(adapter.configDir).toBe(".roo/rules"));
  });

  describe("generate", () => {
    it("generates always-scoped rules under .roo/rules/<id>.md", async () => {
      const files = await adapter.generate([
        { id: "style", name: "Code Style", content: "Use strict TS.", scope: { type: "always" } },
      ]);
      expect(files).toEqual([
        {
          path: ".roo/rules/style.md",
          content: "# Code Style\n\nUse strict TS.\n",
          format: "md",
        },
      ]);
    });

    it("generates agent-scoped rules under .roo/rules-<agentId>/<id>.md", async () => {
      const rule: RuleDefinition = {
        id: "architecture",
        name: "Architecture Rules",
        content: "Keep adapters decoupled.",
        scope: { type: "agent", agentId: "architect" },
      };
      const files = await adapter.generate([rule]);
      expect(files).toEqual([
        {
          path: ".roo/rules-architect/architecture.md",
          content: "# Architecture Rules\n\nKeep adapters decoupled.\n",
          format: "md",
        },
      ]);
    });

    it("handles empty rules array", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });
  });

  describe("import", () => {
    it("returns empty when .roo dir is missing", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(dir)).toEqual([]);
      });
    });

    it("recursively imports .md and .txt across .roo/rules and .roo/rules-<mode>", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".roo/rules/nested"), { recursive: true });
        await mkdir(join(dir, ".roo/rules-architect/deep"), { recursive: true });
        await mkdir(join(dir, ".roo/skills/ignore-me"), { recursive: true });

        await writeFile(
          join(dir, ".roo/rules/general.md"),
          "# General Rule\r\n\r\nAlways write tests.\r\n",
          "utf-8",
        );
        await writeFile(
          join(dir, ".roo/rules/nested/plain.txt"),
          "Plain text rule content\r\nSecond line",
          "utf-8",
        );
        await writeFile(join(dir, ".roo/rules/ignored.json"), '{"ignored":true}', "utf-8");
        await writeFile(
          join(dir, ".roo/rules-architect/deep/design.md"),
          "# Design\n\nPrefer composition.",
          "utf-8",
        );
        await writeFile(join(dir, ".roo/skills/ignore-me/SKILL.md"), "# Skill\n\nSkip", "utf-8");

        const result = await adapter.import(dir);
        expect(result).toEqual([
          {
            id: "general",
            name: "General Rule",
            content: "Always write tests.",
            scope: { type: "always" },
          },
          {
            id: "nested/plain",
            name: "nested/plain",
            content: "Plain text rule content\nSecond line",
            scope: { type: "always" },
          },
          {
            id: "deep/design",
            name: "Design",
            content: "Prefer composition.",
            scope: { type: "agent", agentId: "architect" },
          },
        ]);
      });
    });

    it("round-trips generated global and mode-specific rules", async () => {
      await withTempDir(async (dir) => {
        const rules: RuleDefinition[] = [
          { id: "base", name: "Base", content: "Follow conventions.", scope: { type: "always" } },
          {
            id: "review",
            name: "Review",
            content: "Check edge cases.",
            scope: { type: "agent", agentId: "reviewer" },
          },
        ];

        await adapter.install(await adapter.generate(rules), dir);
        const imported = await adapter.import(dir);
        expect(imported).toEqual(rules);
      });
    });
  });

  describe("detect", () => {
    it("detects .roo/rules or .roo/rules-<mode>", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.detect(dir)).toBe(false);

        await mkdir(join(dir, ".roo/rules-code"), { recursive: true });
        expect(await adapter.detect(dir)).toBe(true);
      });
    });
  });

  describe("uninstall", () => {
    it("removes .roo/rules and .roo/rules-* while preserving other .roo files", async () => {
      await withTempDir(async (dir) => {
        await adapter.install(
          await adapter.generate([
            { id: "a", name: "A", content: "Global", scope: { type: "always" } },
            { id: "b", name: "B", content: "Mode", scope: { type: "agent", agentId: "code" } },
          ]),
          dir,
        );
        await writeFile(join(dir, ".roo/mcp.json"), "{}\n", "utf-8");

        await adapter.uninstall(dir);

        expect(existsSync(join(dir, ".roo/rules"))).toBe(false);
        expect(existsSync(join(dir, ".roo/rules-code"))).toBe(false);
        expect(existsSync(join(dir, ".roo/mcp.json"))).toBe(true);
      });
    });
  });
});
