import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopilotSkillAdapter } from "./copilot.js";
import type { SkillDefinition } from "../types/index.js";

describe("CopilotSkillAdapter", () => {
  let adapter: CopilotSkillAdapter;
  let tempDir: string;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content: "Please review the selected code for security and performance.",
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-copilot-skills-"));
    adapter = new CopilotSkillAdapter();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has expected metadata and userConfigDir", () => {
      expect(adapter.id).toBe("copilot");
      expect(adapter.name).toBe("Copilot");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".github/skills");
      expect(adapter.userConfigDir).toBe(".copilot/skills");
      expect(adapter.command).toBe("copilot");
    });
  });

  describe("generate", () => {
    it("generates folder-based SKILL.md with YAML frontmatter for project layer", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".github/skills/review/SKILL.md");
      expect(files[0]?.format).toBe("md");
      expect(files[0]?.content).toContain(
        "---\nname: review\ndescription: Review code for best practices\n---",
      );
      expect(files[0]?.content).toContain("Please review the selected code");
    });

    it("generates under .copilot/skills for user layer", async () => {
      const files = await adapter.generate([testSkill], "user");
      expect(files[0]?.path).toBe(".copilot/skills/review/SKILL.md");
    });

    it("falls back to skill.name for description when omitted", async () => {
      const files = await adapter.generate([{ id: "lint", name: "Lint", content: "Run lint." }]);
      expect(files[0]?.content).toContain("description: Lint");
    });

    it("copies full skill folder when sourceDir is provided", async () => {
      const srcDir = join(tempDir, "src-skill");
      await mkdir(join(srcDir, "references"), { recursive: true });
      await writeFile(
        join(srcDir, "SKILL.md"),
        "---\nname: custom\ndescription: Custom\n---\n\nBody\n",
      );
      await writeFile(join(srcDir, "references", "guide.md"), "Guide content");

      const files = await adapter.generate([
        { id: "custom", name: "Custom", content: "Body", sourceDir: srcDir },
      ]);

      expect(files.map((f) => f.path).toSorted()).toEqual([
        ".github/skills/custom/SKILL.md",
        ".github/skills/custom/references/guide.md",
      ]);
    });
  });

  describe("install, import, and uninstall", () => {
    it("round-trips generated skills in a real temp dir", async () => {
      const files = await adapter.generate([testSkill]);
      await adapter.install(files, tempDir);

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toEqual({
        id: "review",
        name: "review",
        description: "Review code for best practices",
        content: "Please review the selected code for security and performance.",
      });
    });

    it("parses SKILL.md with CRLF line endings", async () => {
      const skillDir = join(tempDir, ".github/skills/win-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\r\nname: win-skill\r\ndescription: Windows skill\r\n---\r\n\r\nLine 1\r\nLine 2\r\n",
      );

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]?.id).toBe("win-skill");
      expect(imported[0]?.description).toBe("Windows skill");
      expect(imported[0]?.content).toBe("Line 1\r\nLine 2");
    });

    it("skips directories without SKILL.md and returns empty when dir missing", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);

      await mkdir(join(tempDir, ".github/skills/empty-dir"), { recursive: true });
      await writeFile(join(tempDir, ".github/skills/stray.md"), "# Stray");
      expect(await adapter.import(tempDir)).toEqual([]);
    });

    it("escapes special YAML characters and parses quoted/plain SKILL.md", async () => {
      const specialFiles = await adapter.generate([
        { id: "sec", name: "Sec", description: "Check: #1 rule", content: "Inspect." },
      ]);
      expect(specialFiles[0]?.content).toContain('description: "Check: #1 rule"');
      await adapter.install(specialFiles, tempDir);

      const plainDir = join(tempDir, ".github/skills/plain");
      await mkdir(plainDir, { recursive: true });
      await writeFile(join(plainDir, "SKILL.md"), "Just plain markdown body.");

      const singleDir = join(tempDir, ".github/skills/single");
      await mkdir(singleDir, { recursive: true });
      await writeFile(
        join(singleDir, "SKILL.md"),
        "---\nname: 'Single''s Skill'\ndescription: \"Quoted\"\n---\n\nBody.\n",
      );

      const imported = await adapter.import(tempDir);
      expect(imported.find((s) => s.id === "sec")?.description).toBe("Check: #1 rule");
      expect(imported.find((s) => s.id === "plain")).toEqual({
        id: "plain",
        name: "plain",
        content: "Just plain markdown body.",
      });
      expect(imported.find((s) => s.id === "single")?.name).toBe("Single's Skill");
    });

    it("uninstalls skill folders and preserves unrelated files", async () => {
      const files = await adapter.generate([testSkill]);
      await adapter.install(files, tempDir);
      const skillFile = join(tempDir, ".github/skills/review/SKILL.md");
      expect(existsSync(skillFile)).toBe(true);
      expect(await readFile(skillFile, "utf-8")).toContain("review");

      await adapter.uninstall(tempDir);
      expect(existsSync(skillFile)).toBe(false);
      expect(existsSync(join(tempDir, ".github/skills"))).toBe(false);
    });
  });
});
