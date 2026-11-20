import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { CursorSkillAdapter } from "./cursor.js";
import type { SkillDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-skills-cursor-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("CursorSkillAdapter", () => {
  let adapter: CursorSkillAdapter;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content:
      "Please review the selected code for:\n- Security issues\n- Performance\n- Best practices",
  };

  beforeEach(() => {
    adapter = new CursorSkillAdapter();
  });

  describe("metadata", () => {
    it("has correct id", () => expect(adapter.id).toBe("cursor"));
    it("has correct name", () => expect(adapter.name).toBe("Cursor"));
    it("has native support", () => expect(adapter.nativeSupport).toBe(true));
    it("has correct config dir", () => expect(adapter.configDir).toBe(".cursor/skills"));
  });

  describe("generate", () => {
    it("writes SKILL.md under .cursor/skills/<id>/", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".cursor/skills/review/SKILL.md");
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
      expect(files.map((file) => file.path)).toEqual([
        ".cursor/skills/review/SKILL.md",
        ".cursor/skills/debug/SKILL.md",
      ]);
    });

    it("falls back to skill name when description is missing", async () => {
      const skill: SkillDefinition = { id: "test", name: "Test", content: "Content here" };
      const files = await adapter.generate([skill]);
      expect(files[0]?.content).toBe("---\nname: test\ndescription: Test\n---\n\nContent here\n");
    });
  });

  describe("install & uninstall", () => {
    it("writes SKILL.md into a temp project and uninstall removes .cursor/skills", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testSkill]);
        await adapter.install(files, dir);

        const skillPath = join(dir, ".cursor/skills/review/SKILL.md");
        expect(existsSync(skillPath)).toBe(true);
        expect(existsSync(join(dir, ".cursor/prompts/review.md"))).toBe(false);
        const written = await readFile(skillPath, "utf-8");
        expect(written).toContain("name: review");
        expect(written).toContain("Security issues");

        await adapter.uninstall(dir);
        expect(existsSync(join(dir, ".cursor/skills"))).toBe(false);
      });
    });

    it("uninstall is a no-op when .cursor/skills is missing", async () => {
      await withTempDir(async (dir) => {
        await expect(adapter.uninstall(dir)).resolves.toBeUndefined();
      });
    });
  });

  describe("import", () => {
    it("returns empty array when dir does not exist", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(join(dir, "missing"))).toEqual([]);
      });
    });

    it("imports SKILL.md directories with LF and CRLF frontmatter", async () => {
      await withTempDir(async (dir) => {
        const lfDir = join(dir, ".cursor/skills/review");
        const crlfDir = join(dir, ".cursor/skills/crlf-skill");
        await mkdir(lfDir, { recursive: true });
        await mkdir(crlfDir, { recursive: true });
        await writeFile(
          join(lfDir, "SKILL.md"),
          "---\nname: review\ndescription: Review the code\n---\n\nReview the code\n",
        );
        await writeFile(
          join(crlfDir, "SKILL.md"),
          "---\r\nname: crlf-skill\r\ndescription: Windows CRLF skill\r\n---\r\n\r\nCRLF body\r\n",
        );

        const result = await adapter.import(dir);
        const byId = new Map(result.map((s) => [s.id, s]));
        expect(byId.get("review")).toEqual({
          id: "review",
          name: "review",
          description: "Review the code",
          content: "Review the code",
        });
        expect(byId.get("crlf-skill")).toEqual({
          id: "crlf-skill",
          name: "crlf-skill",
          description: "Windows CRLF skill",
          content: "CRLF body",
        });
      });
    });

    it("skips files and folders without SKILL.md", async () => {
      await withTempDir(async (dir) => {
        const skillsDir = join(dir, ".cursor/skills");
        await mkdir(join(skillsDir, "empty"), { recursive: true });
        await mkdir(join(skillsDir, "valid"), { recursive: true });
        await writeFile(join(skillsDir, "readme.txt"), "not a skill");
        await writeFile(
          join(skillsDir, "valid", "SKILL.md"),
          "---\nname: valid\ndescription: ok\n---\n\nBody\n",
        );

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("valid");
      });
    });

    it("imports skill without frontmatter", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".cursor/skills/plain");
        await mkdir(skillDir, { recursive: true });
        await writeFile(join(skillDir, "SKILL.md"), "Just content, no heading");

        const result = await adapter.import(dir);
        expect(result[0]?.name).toBe("plain");
        expect(result[0]?.content).toBe("Just content, no heading");
      });
    });

    it("ignores frontmatter lines without a colon", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".cursor/skills/odd");
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
