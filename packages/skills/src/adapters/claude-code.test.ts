import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { fakeHome } = vi.hoisted(() => ({ fakeHome: { value: "" } }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => fakeHome.value || actual.homedir(),
  };
});

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
    fakeHome.value = "";
  });

  afterEach(() => {
    fakeHome.value = "";
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

    it("safely YAML-quotes descriptions containing special characters and roundtrips them", async () => {
      await withTempDir(async (dir) => {
        const special: SkillDefinition = {
          id: "deploy",
          name: "Deploy",
          description: 'Use when: deploying #prod "safely"',
          content: "Deploy carefully.",
        };
        const files = await adapter.generate([special]);
        expect(files[0]?.content).toContain(`description: ${JSON.stringify(special.description)}`);

        await adapter.install(files, dir);
        const imported = await adapter.import(dir);
        expect(imported).toHaveLength(1);
        expect(imported[0]?.description).toBe(special.description);
        expect(imported[0]?.content).toBe("Deploy carefully.");
      });
    });

    it("falls back to skill name when description is missing", async () => {
      const skill: SkillDefinition = { id: "test", name: "Test", content: "Content here" };
      const files = await adapter.generate([skill]);
      expect(files[0]?.content).toBe("---\nname: test\ndescription: Test\n---\n\nContent here\n");
    });
  });

  describe("install, import, importUser, uninstall", () => {
    it("normalizes CRLF line endings before frontmatter regex", async () => {
      await withTempDir(async (dir) => {
        const skillDir = join(dir, ".claude/skills/win-skill");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          '---\r\nname: win-skill\r\ndescription: "Windows: CRLF"\r\n---\r\n\r\nLine 1\r\nLine 2\r\n',
        );

        const result = await adapter.import(dir);
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("win-skill");
        expect(result[0]?.description).toBe("Windows: CRLF");
        expect(result[0]?.content).toBe("Line 1\nLine 2");
      });
    });

    it("imports user-level skills from ~/.claude/skills via importUser()", async () => {
      await withTempDir(async (home) => {
        fakeHome.value = home;
        const skillDir = join(home, ".claude/skills/user-skill");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          "---\nname: user-skill\ndescription: User scoped\n---\n\nUser instructions\n",
        );

        const result = await adapter.importUser();
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("user-skill");
        expect(result[0]?.description).toBe("User scoped");
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
        const out = join(dir, "out");
        await adapter.install(files, out);
        const installed = join(out, ".claude/skills/brainstorming");
        expect(await readFile(join(installed, "SKILL.md"), "utf-8")).toBe(skillMd);
        expect(await readFile(join(installed, "scripts/start.sh"), "utf-8")).toBe("echo hi\n");
      });
    });

    it("uninstall removes .claude/skills directory", async () => {
      await withTempDir(async (dir) => {
        await adapter.install(await adapter.generate([testSkill]), dir);
        expect(existsSync(join(dir, ".claude/skills/review/SKILL.md"))).toBe(true);

        await adapter.uninstall(dir);
        expect(existsSync(join(dir, ".claude/skills"))).toBe(false);
      });
    });
  });
});
