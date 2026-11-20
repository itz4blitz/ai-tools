import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { OpenCodeSkillAdapter } from "./opencode.js";
import type { SkillDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-skills-opencode-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("OpenCodeSkillAdapter", () => {
  let adapter: OpenCodeSkillAdapter;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content:
      "Please review the selected code for:\n- Security issues\n- Performance\n- Best practices",
  };

  beforeEach(() => {
    adapter = new OpenCodeSkillAdapter();
  });

  describe("metadata", () => {
    it("has correct metadata and user-layer skills dir", async () => {
      expect(adapter.id).toBe("opencode");
      expect(adapter.name).toBe("OpenCode");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".opencode/skills");
      expect(adapter.skillsDir("user")).toBe(".config/opencode/skills");
      const files = await adapter.generate([testSkill], "user");
      expect(files[0]?.path).toBe(`.config/opencode/skills/${testSkill.id}/SKILL.md`);
    });
  });

  describe("generate", () => {
    it("writes SKILL.md under .opencode/skills/<id>/", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".opencode/skills/review/SKILL.md");
      expect(files[0]?.format).toBe("md");
      expect(files[0]?.content).toContain("name: review");
      expect(files[0]?.content).toContain("description: Review code for best practices");
    });

    it("falls back to skill name when description is missing", async () => {
      const skill: SkillDefinition = { id: "test", name: "Test", content: "Content here" };
      const files = await adapter.generate([skill]);
      expect(files[0]?.content).toBe("---\nname: test\ndescription: Test\n---\n\nContent here\n");
    });
  });

  describe("install & uninstall", () => {
    it("writes and removes project-layer skills", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testSkill]);
        await adapter.install(files, dir);

        const skillPath = join(dir, ".opencode/skills/review/SKILL.md");
        expect(existsSync(skillPath)).toBe(true);
        expect(await readFile(skillPath, "utf-8")).toContain("name: review");

        await adapter.uninstall(dir, "project");
        expect(existsSync(join(dir, ".opencode/skills"))).toBe(false);
      });
    });

    it("writes and removes user-layer skills under .config/opencode/skills", async () => {
      await withTempDir(async (fakeHome) => {
        const files = await adapter.generate([testSkill], "user");
        await adapter.install(files, fakeHome);

        const skillPath = join(fakeHome, ".config/opencode/skills/review/SKILL.md");
        expect(existsSync(skillPath)).toBe(true);

        await adapter.uninstall(fakeHome, "user");
        expect(existsSync(join(fakeHome, ".config/opencode/skills"))).toBe(false);
      });
    });
  });

  describe("import & detect", () => {
    it("parses SKILL.md with CRLF line endings", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".opencode/skills/crlf-skill");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          "---\r\nname: crlf-skill\r\ndescription: Works on Windows\r\n---\r\n\r\nLine 1\r\nLine 2\r\n",
        );

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          id: "crlf-skill",
          name: "crlf-skill",
          description: "Works on Windows",
          content: "Line 1\r\nLine 2",
        });
      });
    });

    it("supports layer='user' in detect() and import() for ~/.config/opencode/skills", async () => {
      await withTempDir(async (fakeHome) => {
        expect(await adapter.detect(fakeHome, "user")).toBe(false);

        const userSkillDir = join(fakeHome, ".config/opencode/skills/global-review");
        await mkdir(userSkillDir, { recursive: true });
        await writeFile(
          join(userSkillDir, "SKILL.md"),
          "---\nname: global-review\ndescription: Global skill\n---\n\nBody\n",
        );

        expect(await adapter.detect(fakeHome, "user")).toBe(true);
        const imported = await adapter.import(fakeHome, "user");
        expect(imported).toHaveLength(1);
        expect(imported[0]).toMatchObject({
          id: "global-review",
          name: "global-review",
          description: "Global skill",
          content: "Body",
        });
      });
    });

    it("skips files and folders without SKILL.md and handles missing frontmatter", async () => {
      await withTempDir(async (dir) => {
        const skillsDir = join(dir, ".opencode/skills");
        await mkdir(join(skillsDir, "empty"), { recursive: true });
        await writeFile(join(skillsDir, "readme.txt"), "not a skill");
        await mkdir(join(skillsDir, "plain"), { recursive: true });
        await writeFile(join(skillsDir, "plain", "SKILL.md"), "Just content, no heading");

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          id: "plain",
          name: "plain",
          content: "Just content, no heading",
        });
      });
    });
  });
});
