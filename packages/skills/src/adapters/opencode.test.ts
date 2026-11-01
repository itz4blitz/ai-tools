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
    it("has correct id", () => expect(adapter.id).toBe("opencode"));
    it("has correct name", () => expect(adapter.name).toBe("OpenCode"));
    it("has native support", () => expect(adapter.nativeSupport).toBe(true));
    it("has correct config dir", () => expect(adapter.configDir).toBe(".opencode/skills"));
    it("writes user-layer skills to ~/.config/opencode/skills", async () => {
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
    });

    it("formats Agent Skills frontmatter plus body", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files[0]?.content).toContain("name: review");
      expect(files[0]?.content).toContain("description: Review code for best practices");
      expect(files[0]?.content).toContain("Security issues");
    });

    it("handles empty skills array", async () => {
      const files = await adapter.generate([]);
      expect(files).toHaveLength(0);
    });

    it("handles multiple skills", async () => {
      const skills = [testSkill, { ...testSkill, id: "debug", name: "Debug" }];
      const files = await adapter.generate(skills);
      expect(files).toHaveLength(2);
    });

    it("falls back to skill name when description is missing", async () => {
      const skill: SkillDefinition = { id: "test", name: "Test", content: "Content here" };
      const files = await adapter.generate([skill]);
      expect(files[0]?.content).toBe("---\nname: test\ndescription: Test\n---\n\nContent here\n");
    });
  });

  describe("install", () => {
    it("writes SKILL.md into a temp project, not prompts/ or command/", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testSkill]);
        await adapter.install(files, dir);

        const skillPath = join(dir, ".opencode/skills/review/SKILL.md");
        expect(existsSync(skillPath)).toBe(true);
        expect(existsSync(join(dir, ".opencode/prompts/review.md"))).toBe(false);
        expect(existsSync(join(dir, ".opencode/command/review.md"))).toBe(false);
        expect(await readFile(skillPath, "utf-8")).toContain("name: review");
      });
    });
  });

  describe("import", () => {
    it("returns empty array when dir does not exist", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(join(dir, "missing"))).toEqual([]);
      });
    });

    it("imports SKILL.md directories OpenCode actually loads", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".opencode/skills/review");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          "---\nname: review\ndescription: Review the code\n---\n\nReview the code\n",
        );

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("review");
        expect(result[0]?.name).toBe("review");
      });
    });

    it("skips files and folders without SKILL.md", async () => {
      await withTempDir(async (dir) => {
        const skillsDir = join(dir, ".opencode/skills");
        await mkdir(join(skillsDir, "empty"), { recursive: true });
        await writeFile(join(skillsDir, "readme.txt"), "not a skill");
        await mkdir(join(skillsDir, "skill"), { recursive: true });
        await writeFile(join(skillsDir, "skill", "SKILL.md"), "# Skill\n\nContent");

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
      });
    });

    it("imports skill without frontmatter", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".opencode/skills/plain");
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, "SKILL.md"), "Just content, no heading");

        const result = await adapter.import(dir);
        expect(result[0]?.name).toBe("plain");
        expect(result[0]?.content).toBe("Just content, no heading");
      });
    });

    it("ignores frontmatter lines without a colon", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".opencode/skills/odd");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          "---\nname: odd\nnot-a-pair\ndescription: Odd skill\n---\n\nBody\n",
        );

        const result = await adapter.import(dir);
        expect(result[0]?.name).toBe("odd");
        expect(result[0]?.description).toBe("Odd skill");
      });
    });

    it("imports without cwd argument using process.cwd()", async () => {
      await withTempDir(async (dir) => {
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
        try {
          expect(await adapter.import()).toEqual([]);
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });
  });
});
