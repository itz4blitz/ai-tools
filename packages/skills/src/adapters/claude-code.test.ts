import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { ClaudeCodeSkillAdapter } from "./claude-code.js";
import type { SkillDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-skills-claude-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ClaudeCodeSkillAdapter", () => {
  let adapter: ClaudeCodeSkillAdapter;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content:
      "Please review the selected code for:\n- Security issues\n- Performance\n- Best practices",
  };

  beforeEach(() => {
    adapter = new ClaudeCodeSkillAdapter();
  });

  describe("metadata", () => {
    it("has correct id", () => expect(adapter.id).toBe("claude-code"));
    it("has correct name", () => expect(adapter.name).toBe("Claude Code"));
    it("has native support", () => expect(adapter.nativeSupport).toBe(true));
    it("has correct config dir", () => expect(adapter.configDir).toBe(".claude/skills"));
  });

  describe("generate", () => {
    it("writes SKILL.md under .claude/skills/<id>/", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".claude/skills/review/SKILL.md");
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
      expect(files[1]?.path).toBe(".claude/skills/debug/SKILL.md");
    });

    it("falls back to skill name when description is missing", async () => {
      const skill: SkillDefinition = { id: "test", name: "Test", content: "Content here" };
      const files = await adapter.generate([skill]);
      expect(files[0]?.content).toBe("---\nname: test\ndescription: Test\n---\n\nContent here\n");
    });
  });

  describe("install", () => {
    it("writes SKILL.md into a temp project, not commands/", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testSkill]);
        await adapter.install(files, dir);

        const skillPath = join(dir, ".claude/skills/review/SKILL.md");
        expect(existsSync(skillPath)).toBe(true);
        expect(existsSync(join(dir, ".claude/commands/review.md"))).toBe(false);
        expect(await readFile(skillPath, "utf-8")).toContain("name: review");
      });
    });

    it("copies a sourceDir skill verbatim, supporting files included", async () => {
      await withTempDir(async (dir) => {
        const source = join(dir, "src/brainstorming");
        await mkdir(join(source, "scripts"), { recursive: true });
        const skillMd =
          '---\nname: brainstorming\ndescription: "Use when: designing"\n---\n\nBody\n';
        await writeFile(join(source, "SKILL.md"), skillMd);
        await writeFile(join(source, "scripts/start.sh"), "echo hi\n");

        const skill: SkillDefinition = { ...testSkill, id: "brainstorming", sourceDir: source };
        const files = await adapter.generate([skill]);
        expect(files.map((f) => f.path).toSorted()).toEqual([
          ".claude/skills/brainstorming/SKILL.md",
          ".claude/skills/brainstorming/scripts/start.sh",
        ]);

        const out = join(dir, "out");
        await adapter.install(files, out);
        const installed = join(out, ".claude/skills/brainstorming");
        expect(await readFile(join(installed, "SKILL.md"), "utf-8")).toBe(skillMd);
        expect(await readFile(join(installed, "scripts/start.sh"), "utf-8")).toBe("echo hi\n");
      });
    });
  });

  describe("layers", () => {
    it("uses .claude/skills for both layers", async () => {
      expect(adapter.skillsDir("project")).toBe(".claude/skills");
      expect(adapter.skillsDir("user")).toBe(".claude/skills");
      const files = await adapter.generate([testSkill], "user");
      expect(files[0]?.path).toBe(".claude/skills/review/SKILL.md");
    });
  });

  describe("import", () => {
    it("returns empty array when dir does not exist", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(join(dir, "missing"))).toEqual([]);
      });
    });

    it("imports SKILL.md directories Claude actually loads", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".claude/skills/review");
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
        const skillsDir = join(dir, ".claude/skills");
        await mkdir(join(skillsDir, "empty"), { recursive: true });
        await writeFile(join(skillsDir, "readme.txt"), "not a skill");
        await mkdir(join(skillsDir, "skill"), { recursive: true });
        await writeFile(join(skillsDir, "skill", "SKILL.md"), "# Skill\n\nContent");

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("skill");
      });
    });

    it("imports skill without frontmatter", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".claude/skills/plain");
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, "SKILL.md"), "Just content, no heading");

        const result = await adapter.import(dir);
        expect(result[0]?.name).toBe("plain");
        expect(result[0]?.content).toBe("Just content, no heading");
      });
    });

    it("ignores frontmatter lines without a colon", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".claude/skills/odd");
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
