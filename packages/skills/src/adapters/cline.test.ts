import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClineSkillAdapter } from "./cline.js";
import type { SkillDefinition } from "../types/index.js";

describe("ClineSkillAdapter", () => {
  let adapter: ClineSkillAdapter;
  let tempDir: string;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content:
      "Please review the selected code for:\n- Security issues\n- Performance\n- Best practices",
  };

  beforeEach(async () => {
    adapter = new ClineSkillAdapter();
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-cline-skills-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("uses .cline/skills for project and user layers", () => {
      expect(adapter.id).toBe("cline");
      expect(adapter.name).toBe("Cline");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".cline/skills");
      expect(adapter.userConfigDir).toBe(".cline/skills");
      expect(adapter.skillsDir("project")).toBe(".cline/skills");
      expect(adapter.skillsDir("user")).toBe(".cline/skills");
    });
  });

  describe("generate & install", () => {
    it("generates SKILL.md with YAML frontmatter", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".cline/skills/review/SKILL.md");
      expect(files[0]?.format).toBe("md");
      expect(files[0]?.content).toContain("---\nname: review\n");
      expect(files[0]?.content).toContain("description: Review code for best practices\n---");
      expect(files[0]?.content).toContain("Security issues");
    });

    it("copies full skill folder verbatim when sourceDir is set", async () => {
      const sourceDir = join(tempDir, "src-skill");
      await mkdir(join(sourceDir, "scripts"), { recursive: true });
      await writeFile(
        join(sourceDir, "SKILL.md"),
        "---\nname: deploy\ndescription: Deploy helper\n---\n\nRun scripts/deploy.sh\n",
        "utf-8",
      );
      await writeFile(join(sourceDir, "scripts", "deploy.sh"), "#!/bin/sh\necho ok\n", "utf-8");

      const skillWithDir: SkillDefinition = {
        id: "deploy",
        name: "Deploy",
        content: "",
        sourceDir,
      };

      const projectDir = join(tempDir, "project");
      const files = await adapter.generate([skillWithDir], "project");
      expect(files.map((f) => f.path).toSorted()).toEqual([
        ".cline/skills/deploy/SKILL.md",
        ".cline/skills/deploy/scripts/deploy.sh",
      ]);

      await adapter.install(files, projectDir);
      expect(existsSync(join(projectDir, ".cline", "skills", "deploy", "SKILL.md"))).toBe(true);
      expect(
        await readFile(
          join(projectDir, ".cline", "skills", "deploy", "scripts", "deploy.sh"),
          "utf-8",
        ),
      ).toContain("echo ok");
    });

    it("handles empty skills array", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });
  });

  describe("import & uninstall", () => {
    it("returns empty array when skills dir does not exist", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });

    it("imports SKILL.md folders including CRLF frontmatter", async () => {
      const skillDir = join(tempDir, ".cline", "skills", "win-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        '---\r\nname: win-skill\r\ndescription: "Windows CRLF skill"\r\n---\r\n\r\nLine 1\r\nLine 2\r\n',
        "utf-8",
      );
      // Non-skill dir without SKILL.md should be ignored
      await mkdir(join(tempDir, ".cline", "skills", "empty-dir"), { recursive: true });

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toEqual({
        id: "win-skill",
        name: "win-skill",
        description: "Windows CRLF skill",
        content: "Line 1\nLine 2",
      });
    });

    it("uninstalls skill folders cleanly", async () => {
      const files = await adapter.generate([testSkill]);
      await adapter.install(files, tempDir);
      expect(existsSync(join(tempDir, ".cline", "skills", "review", "SKILL.md"))).toBe(true);

      await adapter.uninstall(tempDir);
      expect(existsSync(join(tempDir, ".cline", "skills", "review"))).toBe(false);
      expect(existsSync(join(tempDir, ".cline", "skills"))).toBe(false);
    });
  });
});
