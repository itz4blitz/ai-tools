import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillDirs } from "./load-dirs.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-skills-dirs-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("loadSkillDirs", () => {
  it("reads each SKILL.md folder with its frontmatter, body, and sourceDir", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "tdd"));
      await writeFile(
        join(dir, "tdd/SKILL.md"),
        '---\r\nname: test-driven-development\r\ndescription: "Use when: writing code"\r\n---\r\n\r\nRed, green, refactor.\r\n',
      );

      expect(loadSkillDirs(dir)).toEqual([
        {
          id: "tdd",
          name: "test-driven-development",
          description: "Use when: writing code",
          content: "Red, green, refactor.",
          sourceDir: join(dir, "tdd"),
        },
      ]);
    });
  });

  it("falls back to the folder name and raw body without frontmatter", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "plain"));
      await writeFile(join(dir, "plain/SKILL.md"), "Just content\n");

      const [skill] = loadSkillDirs(dir);
      expect(skill?.name).toBe("plain");
      expect(skill?.description).toBeUndefined();
      expect(skill?.content).toBe("Just content");
    });
  });

  it("skips files and folders without SKILL.md", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "empty"));
      await writeFile(join(dir, "README.md"), "not a skill");
      await mkdir(join(dir, "real"));
      await writeFile(join(dir, "real/SKILL.md"), "---\nname: real\nbad-line\n---\nBody");

      expect(loadSkillDirs(dir).map((s) => s.id)).toEqual(["real"]);
    });
  });
});
