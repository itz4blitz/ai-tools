import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiCliRuleAdapter } from "./gemini-cli.js";

describe("GeminiCliRuleAdapter", () => {
  let adapter: GeminiCliRuleAdapter;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-gemini-rules-"));
    adapter = new GeminiCliRuleAdapter();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct id, name, configDir, and userConfigPath", () => {
      expect(adapter.id).toBe("gemini-cli");
      expect(adapter.name).toBe("Gemini CLI");
      expect(adapter.configDir).toBe("GEMINI.md");
      expect(adapter.userConfigPath).toMatch(/[/\\]\.gemini[/\\]GEMINI\.md$/);
    });
  });

  describe("generate, install, and uninstall", () => {
    it("returns empty array for no rules", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });

    it("generates GEMINI.md with managed section markers", async () => {
      const files = await adapter.generate([
        {
          id: "ts-strict",
          name: "Strict TypeScript",
          description: "Always keep strict mode clean",
          content: "Never use `any`.",
          scope: { type: "always" },
        },
      ]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe("GEMINI.md");
      expect(files[0]?.content).toContain("<!-- ai-tools:rules:start -->");
      expect(files[0]?.content).toContain("<!-- ai-tools:rules:end -->");
      expect(files[0]?.content).toContain("## Strict TypeScript");
    });

    it("preserves manual user prose on install, update, and uninstall", async () => {
      const geminiPath = join(tempDir, "GEMINI.md");
      await writeFile(geminiPath, "# Project Notes\n\nKeep commits small.\n", "utf-8");

      const firstFiles = await adapter.generate([
        { id: "r1", name: "Rule One", content: "Use vitest.", scope: { type: "always" } },
      ]);
      await adapter.install(firstFiles, tempDir);

      const afterFirst = await readFile(geminiPath, "utf-8");
      expect(afterFirst).toContain("# Project Notes\n\nKeep commits small.");
      expect(afterFirst).toContain("Use vitest.");

      // Re-installing updates the managed block without duplicating it
      const secondFiles = await adapter.generate([
        { id: "r2", name: "Rule Two", content: "Run typecheck.", scope: { type: "always" } },
      ]);
      await adapter.install(secondFiles, tempDir);

      const afterSecond = await readFile(geminiPath, "utf-8");
      expect(afterSecond).toContain("# Project Notes\n\nKeep commits small.");
      expect(afterSecond).not.toContain("Use vitest.");
      expect(afterSecond).toContain("Run typecheck.");
      expect(afterSecond.match(/ai-tools:rules:start/g)).toHaveLength(1);

      // Uninstall removes only the managed section and preserves manual prose
      await adapter.uninstall(tempDir);
      const afterUninstall = await readFile(geminiPath, "utf-8");
      expect(afterUninstall).toBe("# Project Notes\n\nKeep commits small.\n");
    });

    it("deletes GEMINI.md on uninstall when only the managed block existed", async () => {
      const files = await adapter.generate([
        { id: "r1", name: "Only Managed", content: "Managed body.", scope: { type: "always" } },
      ]);
      await adapter.install(files, tempDir);
      expect(existsSync(join(tempDir, "GEMINI.md"))).toBe(true);

      await adapter.uninstall(tempDir);
      expect(existsSync(join(tempDir, "GEMINI.md"))).toBe(false);
    });
  });

  describe("import & user layer", () => {
    it("round-trips managed rules and handles CRLF", async () => {
      const files = await adapter.generate([
        {
          id: "style",
          name: "Style",
          description: "Formatting rules",
          content: "Use 2 spaces.",
          scope: { type: "always" },
        },
        {
          id: "tests",
          name: "Testing",
          content: "Write real tests.",
          scope: { type: "always" },
        },
      ]);
      await writeFile(
        join(tempDir, "GEMINI.md"),
        files[0]!.content.replace(/\n/g, "\r\n"),
        "utf-8",
      );

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(2);
      expect(imported[0]).toEqual({
        id: "style",
        name: "Style",
        description: "Formatting rules",
        content: "Use 2 spaces.",
        scope: { type: "always" },
      });
      expect(imported[1]).toEqual({
        id: "tests",
        name: "Testing",
        content: "Write real tests.",
        scope: { type: "always" },
      });
    });

    it("imports hand-authored GEMINI.md without managed markers", async () => {
      await writeFile(
        join(tempDir, "GEMINI.md"),
        "# Repo Instructions\n\nAlways verify builds.\n",
        "utf-8",
      );
      const imported = await adapter.import(tempDir);
      expect(imported).toEqual([
        {
          id: "gemini-md",
          name: "Repo Instructions",
          content: "Always verify builds.",
          scope: { type: "always" },
        },
      ]);
    });

    it("supports user layer ~/.gemini/GEMINI.md", async () => {
      const fakeUserGemini = join(tempDir, "home", ".gemini", "GEMINI.md");
      Object.defineProperty(adapter, "userConfigPath", { value: fakeUserGemini });

      const files = await adapter.generate([
        { id: "global", name: "Global Rule", content: "Be concise.", scope: { type: "always" } },
      ]);
      await adapter.installUser(files);
      const imported = await adapter.importUser();
      expect(imported).toHaveLength(1);
      expect(imported[0]?.id).toBe("global");

      await adapter.uninstallUser();
      expect(existsSync(fakeUserGemini)).toBe(false);
    });
  });
});
