import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuleDefinition } from "../types/index.js";

vi.mock("./registry.js", () => ({ registry: { register: vi.fn() } }));

vi.mock("node:child_process", () => ({
  exec: vi.fn((_cmd: string, cb: (error: Error | null) => void) => {
    cb(new Error("not found"));
  }),
}));

import { exec } from "node:child_process";
import { ContinueRuleAdapter } from "./continue.js";

describe("ContinueRuleAdapter", () => {
  let adapter: ContinueRuleAdapter;
  let tmp: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "continue-rules-"));
    adapter = new ContinueRuleAdapter();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("exposes Continue identity and cn command", () => {
      expect(adapter.id).toBe("continue");
      expect(adapter.name).toBe("Continue");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".continue/rules");
      expect(adapter.command).toBe("cn");
    });
  });

  describe("generate & round-trip import", () => {
    it("handles empty rules", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });

    it("emits YAML frontmatter and round-trips always, glob, manual, and agent scopes", async () => {
      const rules: RuleDefinition[] = [
        {
          id: "always-rule",
          name: "Always Rule",
          description: "Applied everywhere",
          content: "Use strict TypeScript.",
          scope: { type: "always" },
        },
        {
          id: "glob-rule",
          name: "Glob Rule",
          description: "TS files only",
          content: "Prefer type aliases.",
          scope: { type: "glob", patterns: ["src/**/*.ts", "packages/**/*.tsx"] },
        },
        {
          id: "manual-rule",
          name: "Manual Rule",
          content: "Run benchmarks manually.",
          scope: { type: "manual" },
        },
        {
          id: "agent-rule",
          name: "Agent Rule",
          description: "Use when reviewing PRs",
          content: "Check edge cases.",
          scope: { type: "agent", agentId: "reviewer" },
        },
      ];

      const files = await adapter.generate(rules);
      expect(files.map((f) => f.path)).toEqual([
        ".continue/rules/always-rule.md",
        ".continue/rules/glob-rule.md",
        ".continue/rules/manual-rule.md",
        ".continue/rules/agent-rule.md",
      ]);

      expect(files[0]?.content).toContain("alwaysApply: true");
      expect(files[1]?.content).toContain('  - "src/**/*.ts"');
      expect(files[1]?.content).toContain("alwaysApply: false");
      expect(files[2]?.content).toContain("alwaysApply: false");
      expect(files[3]?.content).toContain("description: Use when reviewing PRs");
      expect(files[3]?.content).not.toContain("alwaysApply:");

      await adapter.install(files, tmp);
      const imported = await adapter.import(tmp);
      const byId = new Map(imported.map((r) => [r.id, r]));

      expect(byId.get("always-rule")).toEqual({
        id: "always-rule",
        name: "Always Rule",
        description: "Applied everywhere",
        content: "Use strict TypeScript.",
        scope: { type: "always" },
      });

      expect(byId.get("glob-rule")).toEqual({
        id: "glob-rule",
        name: "Glob Rule",
        description: "TS files only",
        content: "Prefer type aliases.",
        scope: { type: "glob", patterns: ["src/**/*.ts", "packages/**/*.tsx"] },
      });

      expect(byId.get("manual-rule")).toEqual({
        id: "manual-rule",
        name: "Manual Rule",
        content: "Run benchmarks manually.",
        scope: { type: "manual" },
      });

      expect(byId.get("agent-rule")).toEqual({
        id: "agent-rule",
        name: "Agent Rule",
        description: "Use when reviewing PRs",
        content: "Check edge cases.",
        scope: { type: "agent", agentId: "default" },
      });
    });

    it("synthesizes description for agent scope when description is omitted", async () => {
      const files = await adapter.generate([
        {
          id: "auto-agent",
          name: "Auto Agent",
          content: "Delegate carefully.",
          scope: { type: "agent", agentId: "planner" },
        },
      ]);
      expect(files[0]?.content).toContain("description: Agent rule for planner");
    });

    it("parses CRLF frontmatter, inline globs, plain markdown, and skips non-md files", async () => {
      const rulesDir = join(tmp, ".continue/rules");
      await mkdir(rulesDir, { recursive: true });
      await writeFile(join(rulesDir, "notes.txt"), "ignore me", "utf-8");
      await writeFile(
        join(rulesDir, "crlf.md"),
        '---\r\nname: "CRLF Rule"\r\ndescription: "Win: paths"\r\nglobs: ["*.ts", "*.tsx"]\r\nalwaysApply: false\r\n---\r\n\r\nLine 1\r\nLine 2\r\n',
        "utf-8",
      );
      await writeFile(join(rulesDir, "plain.md"), "# Plain Heading\n\nBody text\n", "utf-8");

      const imported = await adapter.import(tmp);
      expect(imported).toHaveLength(2);
      const byId = new Map(imported.map((r) => [r.id, r]));

      expect(byId.get("crlf")).toEqual({
        id: "crlf",
        name: "CRLF Rule",
        description: "Win: paths",
        content: "Line 1\nLine 2",
        scope: { type: "glob", patterns: ["*.ts", "*.tsx"] },
      });

      expect(byId.get("plain")).toEqual({
        id: "plain",
        name: "Plain Heading",
        content: "Body text",
        scope: { type: "always" },
      });
    });

    it("returns empty array when rules directory does not exist", async () => {
      expect(await adapter.import(tmp)).toEqual([]);
    });
  });

  describe("detect & uninstall", () => {
    it("detects .continue/rules directory or cn binary", async () => {
      expect(await adapter.detect(tmp)).toBe(false);

      await mkdir(join(tmp, ".continue/rules"), { recursive: true });
      expect(await adapter.detect(tmp)).toBe(true);

      await rm(join(tmp, ".continue"), { recursive: true, force: true });
      vi.mocked(exec).mockImplementation(((_cmd, cb) => {
        (cb as (error: Error | null) => void)(null);
      }) as typeof exec);
      expect(await adapter.detect(tmp)).toBe(true);
    });

    it("removes .continue/rules on uninstall and is safe when missing", async () => {
      await adapter.uninstall(tmp);
      const files = await adapter.generate([
        { id: "r1", name: "R1", content: "Body", scope: { type: "always" } },
      ]);
      await adapter.install(files, tmp);
      expect(existsSync(join(tmp, ".continue/rules/r1.md"))).toBe(true);

      await adapter.uninstall(tmp);
      expect(existsSync(join(tmp, ".continue/rules"))).toBe(false);
    });
  });
});
