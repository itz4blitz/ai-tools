import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillDefinition } from "../types/index.js";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { DroidSkillAdapter } from "./droid.js";

describe("DroidSkillAdapter", () => {
  let adapter: DroidSkillAdapter;
  let tmp: string;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content:
      "Please review the selected code for:\n- Security issues\n- Performance\n- Best practices",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new DroidSkillAdapter();
    tmp = await mkdtemp(join(tmpdir(), "ai-tools-droid-skills-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has standardized Factory Droid metadata", () => {
      expect(adapter.id).toBe("droid");
      expect(adapter.name).toBe("Factory Droid");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".factory/skills");
      expect(adapter.userConfigDir).toBe(".factory/skills");
      expect(adapter.command).toBe("droid");
    });
  });

  describe("generate & install", () => {
    it("generates .factory/skills/<id>/SKILL.md with YAML frontmatter", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".factory/skills/review/SKILL.md");
      expect(files[0]?.format).toBe("md");
      expect(files[0]?.content).toBe(
        "---\nname: review\ndescription: Review code for best practices\n---\n\nPlease review the selected code for:\n- Security issues\n- Performance\n- Best practices\n",
      );
    });

    it("supports user layer via skillsDir('user')", async () => {
      const files = await adapter.generate([testSkill], "user");
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".factory/skills/review/SKILL.md");
    });

    it("falls back to skill.name when description is omitted", async () => {
      const skill: SkillDefinition = { id: "test", name: "Test Skill", content: "Content here" };
      const files = await adapter.generate([skill]);
      expect(files[0]?.content).toBe(
        "---\nname: test\ndescription: Test Skill\n---\n\nContent here\n",
      );
    });

    it("copies verbatim files when skill has sourceDir", async () => {
      const sourceDir = join(tmp, "src-skill");
      await mkdir(join(sourceDir, "scripts"), { recursive: true });
      await writeFile(
        join(sourceDir, "SKILL.md"),
        "---\nname: deploy\ndescription: Deploy app\n---\n\nRun deploy.\n",
        "utf-8",
      );
      await writeFile(join(sourceDir, "scripts", "run.sh"), "#!/bin/sh\necho ok\n", "utf-8");

      const skill: SkillDefinition = {
        id: "deploy",
        name: "Deploy",
        description: "Deploy app",
        content: "Run deploy.",
        sourceDir,
      };

      const targetDir = join(tmp, "project");
      const files = await adapter.generate([skill]);
      await adapter.install(files, targetDir);

      expect(existsSync(join(targetDir, ".factory", "skills", "deploy", "SKILL.md"))).toBe(true);
      expect(existsSync(join(targetDir, ".factory", "skills", "deploy", "scripts", "run.sh"))).toBe(
        true,
      );
    });

    it("handles empty skills array", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });
  });

  describe("import", () => {
    it("returns empty array when .factory/skills does not exist", async () => {
      expect(await adapter.import(tmp)).toEqual([]);
    });

    it("imports SKILL.md folders including CRLF line endings", async () => {
      const reviewDir = join(tmp, ".factory", "skills", "review");
      const emptyDir = join(tmp, ".factory", "skills", "empty-folder");
      await mkdir(reviewDir, { recursive: true });
      await mkdir(emptyDir, { recursive: true });
      await writeFile(join(tmp, ".factory", "skills", "stray.md"), "ignore me", "utf-8");
      await writeFile(
        join(reviewDir, "SKILL.md"),
        '---\r\nname: "review"\r\ndescription: "Review PRs"\r\n---\r\n\r\nCheck tests.\r\n',
        "utf-8",
      );

      const imported = await adapter.import(tmp);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toEqual({
        id: "review",
        name: "review",
        description: "Review PRs",
        content: "Check tests.",
      });
    });

    it("imports SKILL.md without frontmatter", async () => {
      const plainDir = join(tmp, ".factory", "skills", "plain");
      await mkdir(plainDir, { recursive: true });
      await writeFile(join(plainDir, "SKILL.md"), "Just instructions.", "utf-8");

      const imported = await adapter.import(tmp);
      expect(imported).toEqual([{ id: "plain", name: "plain", content: "Just instructions." }]);
    });
  });

  describe("uninstall", () => {
    it("removes .factory/skills directory cleanly", async () => {
      await adapter.install(await adapter.generate([testSkill]), tmp);
      const skillsDir = join(tmp, ".factory", "skills");
      expect(existsSync(skillsDir)).toBe(true);

      await adapter.uninstall(tmp);
      expect(existsSync(skillsDir)).toBe(false);
    });

    it("does not throw when .factory/skills does not exist", async () => {
      await expect(adapter.uninstall(tmp)).resolves.toBeUndefined();
    });
  });
});
