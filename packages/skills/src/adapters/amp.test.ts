import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillDefinition } from "../types/index.js";
import { AmpSkillAdapter } from "./amp.js";

describe("AmpSkillAdapter", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ai-tools-amp-skills-"));
    dirs.push(dir);
    return dir;
  }

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content: "Please review the selected code for:\n- Security issues\n- Performance",
  };

  describe("metadata", () => {
    it("has correct id, name, nativeSupport, configDir, and userConfigDir", () => {
      const adapter = new AmpSkillAdapter();
      expect(adapter.id).toBe("amp");
      expect(adapter.name).toBe("Amp");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".agents/skills");
      expect(adapter.userConfigDir).toBe(".config/agents/skills");
    });
  });

  describe("generate", () => {
    it("generates <configDir>/<id>/SKILL.md with YAML frontmatter for project layer", async () => {
      const adapter = new AmpSkillAdapter();
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".agents/skills/review/SKILL.md");
      expect(files[0]!.format).toBe("md");
      expect(files[0]!.content).toBe(
        "---\nname: review\ndescription: Review code for best practices\n---\n\nPlease review the selected code for:\n- Security issues\n- Performance\n",
      );
    });

    it("uses userConfigDir when layer is user", async () => {
      const adapter = new AmpSkillAdapter();
      const files = await adapter.generate([testSkill], "user");
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".config/agents/skills/review/SKILL.md");
    });

    it("falls back to skill.name when description is omitted", async () => {
      const adapter = new AmpSkillAdapter();
      const files = await adapter.generate([
        { id: "debug", name: "Debug", content: "Inspect logs" },
      ]);
      expect(files[0]!.content).toContain("description: Debug\n");
    });

    it("copies sourceDir skill folders verbatim", async () => {
      const srcRoot = await scratch();
      const skillDir = join(srcRoot, "my-skill");
      await mkdir(join(skillDir, "scripts"), { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: my-skill\ndescription: Test\n---\n\nBody\n",
      );
      await writeFile(join(skillDir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");

      const adapter = new AmpSkillAdapter();
      const files = await adapter.generate([
        { id: "my-skill", name: "My Skill", content: "", sourceDir: skillDir },
      ]);

      expect(files.map((f) => f.path).toSorted()).toEqual([
        ".agents/skills/my-skill/SKILL.md",
        ".agents/skills/my-skill/scripts/run.sh",
      ]);
    });
  });

  describe("install, import, and uninstall", () => {
    it("round-trips generated skills on disk", async () => {
      const cwd = await scratch();
      const adapter = new AmpSkillAdapter();
      const files = await adapter.generate([testSkill]);
      await adapter.install(files, cwd);

      expect(existsSync(join(cwd, ".agents/skills/review/SKILL.md"))).toBe(true);
      const imported = await adapter.import(cwd);
      expect(imported).toEqual([
        {
          id: "review",
          name: "review",
          description: "Review code for best practices",
          content: "Please review the selected code for:\n- Security issues\n- Performance",
        },
      ]);
    });

    it("imports SKILL.md files with CRLF line endings and skips non-skill folders", async () => {
      const cwd = await scratch();
      await mkdir(join(cwd, ".agents/skills/win-skill"), { recursive: true });
      await mkdir(join(cwd, ".agents/skills/empty-dir"), { recursive: true });
      await writeFile(
        join(cwd, ".agents/skills/win-skill/SKILL.md"),
        "---\r\nname: Windows Skill\r\ndescription: Handles CRLF\r\n---\r\n\r\nLine 1\r\nLine 2\r\n",
        "utf-8",
      );
      await writeFile(join(cwd, ".agents/skills/notes.txt"), "not a skill", "utf-8");

      const adapter = new AmpSkillAdapter();
      const imported = await adapter.import(cwd);
      expect(imported).toEqual([
        {
          id: "win-skill",
          name: "Windows Skill",
          description: "Handles CRLF",
          content: "Line 1\nLine 2",
        },
      ]);
    });

    it("returns empty array when skills directory does not exist", async () => {
      const cwd = await scratch();
      const adapter = new AmpSkillAdapter();
      expect(await adapter.import(cwd)).toEqual([]);
    });

    it("uninstall removes skill folders and cleans up empty .agents/skills", async () => {
      const cwd = await scratch();
      const adapter = new AmpSkillAdapter();
      await adapter.install(await adapter.generate([testSkill]), cwd);
      expect(existsSync(join(cwd, ".agents/skills/review/SKILL.md"))).toBe(true);

      await adapter.uninstall(cwd);
      expect(existsSync(join(cwd, ".agents/skills"))).toBe(false);
    });

    it("uninstall preserves unrelated non-skill files in .agents/skills", async () => {
      const cwd = await scratch();
      const adapter = new AmpSkillAdapter();
      await adapter.install(await adapter.generate([testSkill]), cwd);
      await writeFile(join(cwd, ".agents/skills/keep.txt"), "keep", "utf-8");

      await adapter.uninstall(cwd);
      expect(existsSync(join(cwd, ".agents/skills/review"))).toBe(false);
      expect(await readFile(join(cwd, ".agents/skills/keep.txt"), "utf-8")).toBe("keep");
    });
  });
});
