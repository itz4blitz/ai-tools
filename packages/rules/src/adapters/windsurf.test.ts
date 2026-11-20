import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({ registry: { register: vi.fn() } }));

import { WindsurfRuleAdapter } from "./windsurf.js";
import type { RuleDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-rules-windsurf-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("WindsurfRuleAdapter", () => {
  let adapter: WindsurfRuleAdapter;

  beforeEach(() => {
    adapter = new WindsurfRuleAdapter();
  });

  describe("metadata", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("windsurf");
      expect(adapter.name).toBe("Windsurf");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".windsurf/rules");
      expect(adapter.command).toBe("windsurf");
    });
  });

  describe("generate", () => {
    it("emits YAML frontmatter for always_on, glob, manual, and model_decision triggers", async () => {
      const rules: RuleDefinition[] = [
        {
          id: "always-rule",
          name: "Always Rule",
          description: "Always applied",
          content: "Use strict TypeScript.",
          scope: { type: "always" },
        },
        {
          id: "ts-rule",
          name: "TS Rule",
          content: "Avoid any.",
          scope: { type: "glob", patterns: ["**/*.ts", "**/*.tsx"] },
        },
        {
          id: "manual-rule",
          name: "Manual Rule",
          content: "Only when mentioned.",
          scope: { type: "manual" },
        },
        {
          id: "model-rule",
          name: "Model Rule",
          description: "Apply when editing SQL migrations",
          content: "Never drop columns directly.",
          scope: { type: "agent", agentId: "cascade" },
        },
      ];

      const files = await adapter.generate(rules);
      expect(files.map((f) => f.path)).toEqual([
        ".windsurf/rules/always-rule.md",
        ".windsurf/rules/ts-rule.md",
        ".windsurf/rules/manual-rule.md",
        ".windsurf/rules/model-rule.md",
      ]);

      expect(files[0]?.content).toBe(
        "---\ntrigger: always_on\ndescription: Always applied\n---\n\nUse strict TypeScript.\n",
      );
      expect(files[1]?.content).toBe(
        "---\ntrigger: glob\nglobs: **/*.ts, **/*.tsx\n---\n\nAvoid any.\n",
      );
      expect(files[2]?.content).toBe("---\ntrigger: manual\n---\n\nOnly when mentioned.\n");
      expect(files[3]?.content).toBe(
        "---\ntrigger: model_decision\ndescription: Apply when editing SQL migrations\n---\n\nNever drop columns directly.\n",
      );
    });

    it("handles empty rules", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });
  });

  describe("import and uninstall", () => {
    it("returns empty array when rules dir and legacy file are missing", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(dir)).toEqual([]);
      });
    });

    it("round-trips generated rules and parses CRLF + YAML list globs", async () => {
      await withTempDir(async (dir) => {
        const rules: RuleDefinition[] = [
          {
            id: "always-rule",
            name: "always-rule",
            description: "Always applied",
            content: "Use strict TS.",
            scope: { type: "always" },
          },
          {
            id: "glob-rule",
            name: "glob-rule",
            content: "No console.log.",
            scope: { type: "glob", patterns: ["src/**/*.ts", "tests/**/*.ts"] },
          },
          {
            id: "manual-rule",
            name: "manual-rule",
            content: "Run checks.",
            scope: { type: "manual" },
          },
          {
            id: "model-rule",
            name: "model-rule",
            description: "When touching auth",
            content: "Check session expiry.",
            scope: { type: "agent", agentId: "cascade" },
          },
        ];

        await adapter.install(await adapter.generate(rules), dir);
        await writeFile(
          join(dir, ".windsurf/rules/crlf-list.md"),
          '---\r\ntrigger: glob\r\nglobs:\r\n  - "*.sql"\r\n  - "migrations/**"\r\n---\r\n\r\nCheck indexes.\r\n',
          "utf-8",
        );

        const imported = await adapter.import(dir);
        const byId = new Map(imported.map((r) => [r.id, r]));

        expect(byId.get("always-rule")).toEqual(rules[0]);
        expect(byId.get("glob-rule")).toEqual(rules[1]);
        expect(byId.get("manual-rule")).toEqual(rules[2]);
        expect(byId.get("model-rule")).toEqual(rules[3]);
        expect(byId.get("crlf-list")).toEqual({
          id: "crlf-list",
          name: "crlf-list",
          content: "Check indexes.",
          scope: { type: "glob", patterns: ["*.sql", "migrations/**"] },
        });
      });
    });

    it("imports legacy .windsurfrules alongside .windsurf/rules", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".windsurf/rules"), { recursive: true });
        await writeFile(join(dir, ".windsurf/rules/plain.md"), "# Plain\n\nBody text", "utf-8");
        await writeFile(join(dir, ".windsurfrules"), "Legacy global rule\r\nLine 2\r\n", "utf-8");

        const imported = await adapter.import(dir);
        expect(imported).toEqual([
          { id: "plain", name: "Plain", content: "Body text", scope: { type: "always" } },
          {
            id: "windsurfrules",
            name: "Windsurf Rules",
            content: "Legacy global rule\nLine 2",
            scope: { type: "always" },
          },
        ]);
      });
    });

    it("uninstalls .windsurf/rules markdown files without removing legacy .windsurfrules", async () => {
      await withTempDir(async (dir) => {
        await adapter.install(
          await adapter.generate([
            { id: "r1", name: "R1", content: "Body", scope: { type: "always" } },
          ]),
          dir,
        );
        await writeFile(join(dir, ".windsurfrules"), "Keep legacy\n", "utf-8");

        await adapter.uninstall(dir);

        expect(existsSync(join(dir, ".windsurf/rules"))).toBe(false);
        expect(existsSync(join(dir, ".windsurfrules"))).toBe(true);
      });
    });
  });
});
