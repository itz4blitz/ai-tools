import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { CodexSkillAdapter } from "./codex.js";
import type { SkillDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-skills-codex-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("CodexSkillAdapter", () => {
  let adapter: CodexSkillAdapter;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content:
      "Please review the selected code for:\n- Security issues\n- Performance\n- Best practices",
  };

  beforeEach(() => {
    adapter = new CodexSkillAdapter();
  });

  describe("metadata", () => {
    it("uses .agents/skills for both project and user layers", async () => {
      expect(adapter.id).toBe("codex");
      expect(adapter.name).toBe("Codex");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".agents/skills");
      expect(adapter.userConfigDir).toBe(".agents/skills");
      expect(adapter.skillsDir("project")).toBe(".agents/skills");
      expect(adapter.skillsDir("user")).toBe(".agents/skills");
    });
  });

  describe("generate", () => {
    it("writes SKILL.md under .agents/skills/<id>/", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".agents/skills/review/SKILL.md");
      expect(files[0]?.format).toBe("md");
      expect(files[0]?.content).toContain("name: review");
      expect(files[0]?.content).toContain("description: Review code for best practices");
    });

    it("YAML-escapes frontmatter values containing colons, hashes, or newlines", async () => {
      const trickySkill: SkillDefinition = {
        id: "release-check",
        name: "Release: Check #1",
        description: 'Verify: build & "lint"\nThen deploy #prod',
        content: "Run checks.",
      };
      const files = await adapter.generate([trickySkill]);
      expect(files[0]?.content).toContain(
        'description: "Verify: build & \\"lint\\"\\nThen deploy #prod"',
      );

      // Round-trip through install + import
      await withTempDir(async (dir) => {
        await adapter.install(files, dir);
        const imported = await adapter.import(dir);
        expect(imported).toHaveLength(1);
        expect(imported[0]?.description).toBe('Verify: build & "lint"\nThen deploy #prod');
      });
    });

    it("handles empty skills array and falls back to skill name when description is missing", async () => {
      expect(await adapter.generate([])).toHaveLength(0);

      const skill: SkillDefinition = { id: "test", name: "Test", content: "Content here" };
      const files = await adapter.generate([skill]);
      expect(files[0]?.content).toBe("---\nname: test\ndescription: Test\n---\n\nContent here\n");
    });
  });

  describe("install and uninstall", () => {
    it("installs into .agents/skills and removes installed skills on uninstall", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testSkill]);
        await adapter.install(files, dir);

        const skillPath = join(dir, ".agents/skills/review/SKILL.md");
        expect(existsSync(skillPath)).toBe(true);
        expect(await readFile(skillPath, "utf-8")).toContain("name: review");

        await adapter.uninstall(dir, "project");
        expect(existsSync(skillPath)).toBe(false);
        expect(existsSync(join(dir, ".agents/skills"))).toBe(false);
      });
    });

    it("preserves bundled .system directory on uninstall", async () => {
      await withTempDir(async (dir) => {
        const systemDir = join(dir, ".codex/skills/.system");
        await mkdir(systemDir, { recursive: true });
        await writeFile(join(systemDir, "SKILL.md"), "---\nname: sys\n---\n\nSystem", "utf-8");

        const userSkillDir = join(dir, ".codex/skills/custom");
        await mkdir(userSkillDir, { recursive: true });
        await writeFile(
          join(userSkillDir, "SKILL.md"),
          "---\nname: custom\n---\n\nCustom",
          "utf-8",
        );

        await adapter.uninstall(dir, "project");
        expect(existsSync(userSkillDir)).toBe(false);
        expect(existsSync(join(systemDir, "SKILL.md"))).toBe(true);
      });
    });
  });

  describe("import and detect", () => {
    it("normalizes CRLF line endings in SKILL.md", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".agents/skills/crlf-skill");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          "---\r\nname: crlf-skill\r\ndescription: Windows line endings\r\n---\r\n\r\nLine 1\r\nLine 2\r\n",
          "utf-8",
        );

        const imported = await adapter.import(dir);
        expect(imported).toHaveLength(1);
        expect(imported[0]).toEqual({
          id: "crlf-skill",
          name: "crlf-skill",
          description: "Windows line endings",
          content: "Line 1\nLine 2",
        });
      });
    });

    it("discovers .agents/skills first and falls back to .codex/skills for both project and user layers", async () => {
      await withTempDir(async (dir) => {
        const primaryDir = join(dir, ".agents/skills/shared");
        const fallbackSharedDir = join(dir, ".codex/skills/shared");
        const fallbackOnlyDir = join(dir, ".codex/skills/legacy");
        const systemDir = join(dir, ".codex/skills/.system");

        await mkdir(primaryDir, { recursive: true });
        await mkdir(fallbackSharedDir, { recursive: true });
        await mkdir(fallbackOnlyDir, { recursive: true });
        await mkdir(systemDir, { recursive: true });

        await writeFile(
          join(primaryDir, "SKILL.md"),
          "---\nname: shared\ndescription: From .agents\n---\n\nPrimary body\n",
          "utf-8",
        );
        await writeFile(
          join(fallbackSharedDir, "SKILL.md"),
          "---\nname: shared\ndescription: From .codex\n---\n\nFallback body\n",
          "utf-8",
        );
        await writeFile(
          join(fallbackOnlyDir, "SKILL.md"),
          "---\nname: legacy\ndescription: Legacy skill\n---\n\nLegacy body\n",
          "utf-8",
        );
        await writeFile(join(systemDir, "SKILL.md"), "---\nname: system\n---\n\nIgnore\n", "utf-8");

        expect(await adapter.detect(dir, "project")).toBe(true);
        expect(await adapter.detect(dir, "user")).toBe(true);

        const imported = await adapter.import(dir, "project");
        expect(imported.map((s) => s.id)).toEqual(["shared", "legacy"]);
        expect(imported[0]?.description).toBe("From .agents");
        expect(imported[1]?.description).toBe("Legacy skill");
      });
    });

    it("detects fallback .codex/skills when .agents/skills is absent", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".codex/skills"), { recursive: true });
        expect(await adapter.detect(dir, "project")).toBe(true);
      });
    });
  });
});
