import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { RooCodeSkillAdapter } from "./roo-code.js";
import type { SkillDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-skills-roo-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("RooCodeSkillAdapter", () => {
  let adapter: RooCodeSkillAdapter;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content:
      "Please review the selected code for:\n- Security issues\n- Performance\n- Best practices",
  };

  beforeEach(() => {
    adapter = new RooCodeSkillAdapter();
  });

  describe("metadata", () => {
    it("has correct id", () => expect(adapter.id).toBe("roo-code"));
    it("has correct name", () => expect(adapter.name).toBe("Roo Code"));
    it("has native support", () => expect(adapter.nativeSupport).toBe(true));
    it("has correct configDir", () => expect(adapter.configDir).toBe(".roo/skills"));
    it("has correct userConfigDir", () => expect(adapter.userConfigDir).toBe(".roo/skills"));
  });

  describe("generate", () => {
    it("generates SKILL.md under .roo/skills/<id>/", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".roo/skills/review/SKILL.md");
      expect(files[0]?.format).toBe("md");
    });

    it("formats YAML frontmatter with name, description, and body", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files[0]?.content).toBe(
        `---\nname: review\ndescription: Review code for best practices\n---\n\n${testSkill.content}\n`,
      );
    });

    it("falls back to skill name when description is missing", async () => {
      const skill: SkillDefinition = { id: "test", name: "Test Skill", content: "Content here" };
      const files = await adapter.generate([skill]);
      expect(files[0]?.content).toBe(
        "---\nname: test\ndescription: Test Skill\n---\n\nContent here\n",
      );
    });

    it("handles empty skills array", async () => {
      const files = await adapter.generate([]);
      expect(files).toHaveLength(0);
    });

    it("handles multiple skills", async () => {
      const skills = [testSkill, { ...testSkill, id: "debug", name: "Debug" }];
      const files = await adapter.generate(skills);
      expect(files).toHaveLength(2);
      expect(files[1]?.path).toBe(".roo/skills/debug/SKILL.md");
    });

    it("supports user layer using userConfigDir", async () => {
      expect(adapter.skillsDir("project")).toBe(".roo/skills");
      expect(adapter.skillsDir("user")).toBe(".roo/skills");
      const files = await adapter.generate([testSkill], "user");
      expect(files[0]?.path).toBe(".roo/skills/review/SKILL.md");
    });
  });

  describe("install", () => {
    it("writes SKILL.md into .roo/skills/<id>/", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testSkill]);
        await adapter.install(files, dir);

        const skillPath = join(dir, ".roo/skills/review/SKILL.md");
        expect(existsSync(skillPath)).toBe(true);
        expect(await readFile(skillPath, "utf-8")).toContain("name: review");
      });
    });

    it("copies a sourceDir skill verbatim including supporting files", async () => {
      await withTempDir(async (dir) => {
        const source = join(dir, "src/brainstorming");
        await mkdir(join(source, "scripts"), { recursive: true });
        await mkdir(join(source, "references"), { recursive: true });
        const skillMd =
          '---\nname: brainstorming\ndescription: "Use when designing"\n---\n\nDesign carefully.\n';
        await writeFile(join(source, "SKILL.md"), skillMd, "utf-8");
        await writeFile(join(source, "scripts/check.sh"), "echo ok\n", "utf-8");
        await writeFile(join(source, "references/guide.md"), "# Guide\n", "utf-8");

        const skill: SkillDefinition = { ...testSkill, id: "brainstorming", sourceDir: source };
        const files = await adapter.generate([skill]);
        expect(files.map((f) => f.path).toSorted()).toEqual([
          ".roo/skills/brainstorming/SKILL.md",
          ".roo/skills/brainstorming/references/guide.md",
          ".roo/skills/brainstorming/scripts/check.sh",
        ]);

        const out = join(dir, "project");
        await adapter.install(files, out);
        expect(await readFile(join(out, ".roo/skills/brainstorming/SKILL.md"), "utf-8")).toBe(
          skillMd,
        );
        expect(
          await readFile(join(out, ".roo/skills/brainstorming/scripts/check.sh"), "utf-8"),
        ).toBe("echo ok\n");
        expect(
          await readFile(join(out, ".roo/skills/brainstorming/references/guide.md"), "utf-8"),
        ).toBe("# Guide\n");
      });
    });
  });

  describe("import", () => {
    it("returns empty array when dir does not exist", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(join(dir, "missing"))).toEqual([]);
      });
    });

    it("imports skills from <id>/SKILL.md with frontmatter", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".roo/skills/review");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          '---\nname: review\ndescription: "Review code changes"\n---\n\nCheck security.\n',
          "utf-8",
        );

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          id: "review",
          name: "review",
          description: "Review code changes",
          content: "Check security.",
        });
      });
    });

    it("handles CRLF line endings in SKILL.md", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".roo/skills/win-skill");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          "---\r\nname: win-skill\r\ndescription: Windows skill\r\n---\r\n\r\nLine 1\r\nLine 2\r\n",
          "utf-8",
        );

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          id: "win-skill",
          name: "win-skill",
          description: "Windows skill",
          content: "Line 1\nLine 2",
        });
      });
    });

    it("skips files and folders without SKILL.md", async () => {
      await withTempDir(async (dir) => {
        const skillsDir = join(dir, ".roo/skills");
        await mkdir(join(skillsDir, "empty"), { recursive: true });
        await writeFile(join(skillsDir, "stray.md"), "# Stray\n\nIgnored", "utf-8");
        await mkdir(join(skillsDir, "valid"), { recursive: true });
        await writeFile(join(skillsDir, "valid/SKILL.md"), "# Valid Skill\n\nBody", "utf-8");

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          id: "valid",
          name: "Valid Skill",
          content: "Body",
        });
      });
    });

    it("imports plain SKILL.md without frontmatter or heading", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".roo/skills/plain");
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, "SKILL.md"), "Just content, no heading", "utf-8");

        const result = await adapter.import(dir);
        expect(result).toEqual([
          { id: "plain", name: "plain", content: "Just content, no heading" },
        ]);
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

  describe("uninstall", () => {
    it("removes .roo/skills directory while keeping other .roo files intact", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testSkill]);
        await adapter.install(files, dir);
        await writeFile(join(dir, ".roo/mcp.json"), "{}\n", "utf-8");

        await adapter.uninstall(dir);

        expect(existsSync(join(dir, ".roo/skills"))).toBe(false);
        expect(existsSync(join(dir, ".roo/mcp.json"))).toBe(true);
      });
    });

    it("is a no-op when .roo/skills does not exist", async () => {
      await withTempDir(async (dir) => {
        await expect(adapter.uninstall(dir)).resolves.toBeUndefined();
      });
    });
  });
});
