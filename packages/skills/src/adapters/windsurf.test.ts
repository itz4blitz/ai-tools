import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { WindsurfSkillAdapter } from "./windsurf.js";
import type { SkillDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-skills-windsurf-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("WindsurfSkillAdapter", () => {
  let adapter: WindsurfSkillAdapter;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content:
      "Please review the selected code for:\n- Security issues\n- Performance\n- Best practices",
  };

  beforeEach(() => {
    adapter = new WindsurfSkillAdapter();
  });

  describe("metadata", () => {
    it("has correct metadata including userConfigDir", () => {
      expect(adapter.id).toBe("windsurf");
      expect(adapter.name).toBe("Windsurf");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".windsurf/skills");
      expect(adapter.userConfigDir).toBe(".codeium/windsurf/skills");
      expect(adapter.command).toBe("windsurf");
    });
  });

  describe("generate", () => {
    it("writes SKILL.md under .windsurf/skills/<id>/ for project layer", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".windsurf/skills/review/SKILL.md");
      expect(files[0]?.format).toBe("md");
      expect(files[0]?.content).toBe(
        "---\nname: review\ndescription: Review code for best practices\n---\n\nPlease review the selected code for:\n- Security issues\n- Performance\n- Best practices\n",
      );
    });

    it("writes SKILL.md under .codeium/windsurf/skills/<id>/ for user layer", async () => {
      const files = await adapter.generate([testSkill], "user");
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".codeium/windsurf/skills/review/SKILL.md");
    });

    it("falls back to skill name when description is omitted", async () => {
      const skill: SkillDefinition = { id: "test", name: "Test", content: "Content here" };
      const files = await adapter.generate([skill]);
      expect(files[0]?.content).toBe("---\nname: test\ndescription: Test\n---\n\nContent here\n");
    });

    it("copies full skill folder when sourceDir is set", async () => {
      await withTempDir(async (dir) => {
        const src = join(dir, "src-skill");
        await mkdir(join(src, "scripts"), { recursive: true });
        await writeFile(join(src, "SKILL.md"), "---\nname: review\ndescription: d\n---\n\nBody\n");
        await writeFile(join(src, "scripts", "check.sh"), "echo ok\n");

        const files = await adapter.generate([{ ...testSkill, sourceDir: src }]);
        const paths = files.map((f) => f.path).toSorted();
        expect(paths).toEqual([
          ".windsurf/skills/review/SKILL.md",
          ".windsurf/skills/review/scripts/check.sh",
        ]);
      });
    });

    it("handles empty skills array", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });
  });

  describe("install, import, and uninstall", () => {
    it("round-trips generated skills in a temp dir", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testSkill]);
        await adapter.install(files, dir);

        const skillPath = join(dir, ".windsurf/skills/review/SKILL.md");
        expect(existsSync(skillPath)).toBe(true);
        const written = await readFile(skillPath, "utf-8");
        expect(written).toContain("name: review");

        const imported = await adapter.import(dir);
        expect(imported).toEqual([
          {
            id: "review",
            name: "review",
            description: "Review code for best practices",
            content: testSkill.content,
          },
        ]);
      });
    });

    it("parses SKILL.md with CRLF line endings", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".windsurf/skills/crlf-skill");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          "---\r\nname: crlf-skill\r\ndescription: Windows CRLF\r\n---\r\n\r\nLine 1\r\nLine 2\r\n",
          "utf-8",
        );

        const imported = await adapter.import(dir);
        expect(imported).toEqual([
          {
            id: "crlf-skill",
            name: "crlf-skill",
            description: "Windows CRLF",
            content: "Line 1\nLine 2",
          },
        ]);
      });
    });

    it("returns empty array when skills dir is missing and skips non-skill entries", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(dir)).toEqual([]);

        const skillsDir = join(dir, ".windsurf/skills");
        await mkdir(join(skillsDir, "empty"), { recursive: true });
        await writeFile(join(skillsDir, "notes.txt"), "ignore me");
        expect(await adapter.import(dir)).toEqual([]);
      });
    });

    it("uninstalls skill folders while preserving unrelated sibling files", async () => {
      await withTempDir(async (dir) => {
        await adapter.install(await adapter.generate([testSkill]), dir);
        await writeFile(join(dir, ".windsurf/hooks.json"), "{}\n", "utf-8");

        await adapter.uninstall(dir);

        expect(existsSync(join(dir, ".windsurf/skills"))).toBe(false);
        expect(existsSync(join(dir, ".windsurf/hooks.json"))).toBe(true);
      });
    });
  });
});
