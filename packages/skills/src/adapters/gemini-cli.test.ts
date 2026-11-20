import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiCliSkillAdapter } from "./gemini-cli.js";
import type { SkillDefinition } from "../types/index.js";

describe("GeminiCliSkillAdapter", () => {
  let adapter: GeminiCliSkillAdapter;
  let tempDir: string;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content: "Please review the selected code for security and performance.",
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-gemini-skills-"));
    adapter = new GeminiCliSkillAdapter();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct id, name, configDir, and userConfigDir", () => {
      expect(adapter.id).toBe("gemini-cli");
      expect(adapter.name).toBe("Gemini CLI");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".gemini/skills");
      expect(adapter.userConfigDir).toBe(".gemini/skills");
    });
  });

  describe("generate & install", () => {
    it("generates SKILL.md folder layout with YAML frontmatter", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".gemini/skills/review/SKILL.md");
      expect(files[0]?.format).toBe("md");
      expect(files[0]?.content).toContain(
        "---\nname: review\ndescription: Review code for best practices\n---",
      );
      expect(files[0]?.content).toContain("Please review the selected code");
    });

    it("supports user layer via skillsDir('user')", async () => {
      const files = await adapter.generate([testSkill], "user");
      expect(files[0]?.path).toBe(".gemini/skills/review/SKILL.md");
    });

    it("copies sourceDir folders verbatim including nested helper files", async () => {
      const sourceDir = join(tempDir, "src-skill");
      await mkdir(join(sourceDir, "scripts"), { recursive: true });
      await writeFile(
        join(sourceDir, "SKILL.md"),
        "---\nname: deploy\ndescription: Deploy app\n---\n\nRun deploy.\n",
        "utf-8",
      );
      await writeFile(join(sourceDir, "scripts", "run.sh"), "#!/bin/sh\necho ok\n", "utf-8");

      const files = await adapter.generate([
        { id: "deploy", name: "Deploy", content: "", sourceDir },
      ]);
      const paths = files.map((f) => f.path).toSorted();
      expect(paths).toEqual([
        ".gemini/skills/deploy/SKILL.md",
        ".gemini/skills/deploy/scripts/run.sh",
      ]);

      const destDir = join(tempDir, "project");
      await adapter.install(files, destDir);
      expect(await readFile(join(destDir, ".gemini/skills/deploy/scripts/run.sh"), "utf-8")).toBe(
        "#!/bin/sh\necho ok\n",
      );
    });
  });

  describe("import & uninstall", () => {
    it("returns empty array when skills dir does not exist", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });

    it("imports SKILL.md folders with CRLF frontmatter support", async () => {
      const skillDir = join(tempDir, ".gemini", "skills", "review");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\r\nname: review\r\ndescription: Review PRs\r\n---\r\n\r\nCheck tests first.\r\n",
        "utf-8",
      );

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toEqual({
        id: "review",
        name: "review",
        description: "Review PRs",
        content: "Check tests first.",
      });
    });

    it("removes .gemini/skills on uninstall", async () => {
      const files = await adapter.generate([testSkill]);
      await adapter.install(files, tempDir);
      expect(existsSync(join(tempDir, ".gemini", "skills", "review", "SKILL.md"))).toBe(true);

      await adapter.uninstall(tempDir);
      expect(existsSync(join(tempDir, ".gemini", "skills"))).toBe(false);
    });
  });
});
