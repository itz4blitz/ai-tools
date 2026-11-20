import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KiroRuleAdapter } from "./kiro.js";
import type { RuleDefinition } from "../types/index.js";

describe("KiroRuleAdapter", () => {
  let adapter: KiroRuleAdapter;
  let tempDir: string;

  beforeEach(async () => {
    adapter = new KiroRuleAdapter();
    tempDir = await mkdtemp(join(tmpdir(), "kiro-rules-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct id, name, nativeSupport, and configDir", () => {
      expect(adapter.id).toBe("kiro");
      expect(adapter.name).toBe("Kiro");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".kiro/steering");
    });
  });

  describe("generate & import", () => {
    it("generates and imports always, fileMatch (single & multi), and manual steering rules", async () => {
      const rules: RuleDefinition[] = [
        {
          id: "always-rule",
          name: "Always Rule",
          description: "Applied everywhere",
          content: "Always use TypeScript strict mode.",
          scope: { type: "always" },
        },
        {
          id: "glob-single",
          name: "Glob Single",
          content: "Follow API conventions.",
          scope: { type: "glob", patterns: ["src/api/**/*.ts"] },
        },
        {
          id: "glob-multi",
          name: "Glob Multi",
          content: "Write deterministic tests.",
          scope: { type: "glob", patterns: ["**/*.test.ts", "**/*.spec.ts"] },
        },
        {
          id: "manual-rule",
          name: "Manual Rule",
          content: "Release checklist.",
          scope: { type: "manual" },
        },
      ];

      const files = await adapter.generate(rules);
      expect(files).toHaveLength(4);
      expect(files[0]!.path).toBe(".kiro/steering/always-rule.md");
      expect(files[0]!.content).toContain("inclusion: always");
      expect(files[1]!.content).toContain("inclusion: fileMatch");
      expect(files[1]!.content).toContain('fileMatchPattern: "src/api/**/*.ts"');
      expect(files[2]!.content).toContain("inclusion: fileMatch");
      expect(files[2]!.content).toContain('  - "**/*.test.ts"');
      expect(files[3]!.content).toContain("inclusion: manual");

      await adapter.install(files, tempDir);
      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(4);

      expect(imported.find((r) => r.id === "always-rule")?.scope).toEqual({ type: "always" });
      expect(imported.find((r) => r.id === "always-rule")?.description).toBe("Applied everywhere");
      expect(imported.find((r) => r.id === "glob-single")?.scope).toEqual({
        type: "glob",
        patterns: ["src/api/**/*.ts"],
      });
      expect(imported.find((r) => r.id === "glob-multi")?.scope).toEqual({
        type: "glob",
        patterns: ["**/*.test.ts", "**/*.spec.ts"],
      });
      expect(imported.find((r) => r.id === "manual-rule")?.scope).toEqual({ type: "manual" });
    });

    it("parses CRLF steering files and plain markdown files without frontmatter", async () => {
      const steeringDir = join(tempDir, ".kiro", "steering");
      await mkdir(steeringDir, { recursive: true });
      await writeFile(
        join(steeringDir, "crlf.md"),
        '---\r\ninclusion: fileMatch\r\nfileMatchPattern: "src/**/*.ts"\r\n---\r\n\r\nUse strict types.\r\n',
        "utf-8",
      );
      await writeFile(
        join(steeringDir, "plain.md"),
        "# Plain Steering\n\nPlain content here.\n",
        "utf-8",
      );

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(2);

      const crlf = imported.find((r) => r.id === "crlf");
      expect(crlf?.scope).toEqual({ type: "glob", patterns: ["src/**/*.ts"] });
      expect(crlf?.content).toBe("Use strict types.");

      const plain = imported.find((r) => r.id === "plain");
      expect(plain?.name).toBe("Plain Steering");
      expect(plain?.scope).toEqual({ type: "always" });
      expect(plain?.content).toBe("Plain content here.");
    });

    it("returns empty array when steering dir is missing", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });
  });

  describe("detect & uninstall", () => {
    it("detects .kiro/steering dir or kiro / kiro-cli binaries", async () => {
      const spy = vi
        .spyOn(
          adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
          "commandExists",
        )
        .mockImplementation(async (cmd) => cmd === "kiro-cli");

      expect(await adapter.detect(tempDir)).toBe(true);
      expect(spy).toHaveBeenCalledWith("kiro");
      expect(spy).toHaveBeenCalledWith("kiro-cli");

      spy.mockResolvedValue(false);
      expect(await adapter.detect(tempDir)).toBe(false);

      await mkdir(join(tempDir, ".kiro", "steering"), { recursive: true });
      expect(await adapter.detect(tempDir)).toBe(true);
    });

    it("uninstall removes markdown steering files and cleans up empty dir", async () => {
      const files = await adapter.generate([
        { id: "r1", name: "R1", content: "Body", scope: { type: "always" } },
      ]);
      await adapter.install(files, tempDir);
      expect(existsSync(join(tempDir, ".kiro", "steering", "r1.md"))).toBe(true);

      await adapter.uninstall(tempDir);
      expect(existsSync(join(tempDir, ".kiro", "steering"))).toBe(false);
    });
  });
});
