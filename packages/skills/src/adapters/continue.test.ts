import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillDefinition } from "../types/index.js";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (error: Error | null) => void) => {
    cb(new Error("not found"));
  }),
}));

import { execFile } from "node:child_process";
import { ContinueSkillAdapter } from "./continue.js";

describe("ContinueSkillAdapter", () => {
  let adapter: ContinueSkillAdapter;
  let tmp: string;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content: "Check security, performance, and tests.",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "continue-skills-"));
    adapter = new ContinueSkillAdapter();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has Continue skill metadata and cn command", () => {
      expect(adapter.id).toBe("continue");
      expect(adapter.name).toBe("Continue");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".continue/skills");
      expect(adapter.userConfigDir).toBe(".continue/skills");
      expect(adapter.command).toBe("cn");
      expect(adapter.skillsDir("project")).toBe(".continue/skills");
      expect(adapter.skillsDir("user")).toBe(".continue/skills");
    });
  });

  describe("generate & install", () => {
    it("generates .continue/skills/<id>/SKILL.md with YAML frontmatter including invokable: true", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".continue/skills/review/SKILL.md");
      expect(files[0]?.format).toBe("md");
      expect(files[0]?.content).toBe(
        "---\nname: Code Review\ndescription: Review code for best practices\ninvokable: true\n---\n\nCheck security, performance, and tests.\n",
      );

      await adapter.install(files, tmp);
      const written = await readFile(join(tmp, ".continue/skills/review/SKILL.md"), "utf-8");
      expect(written).toBe(files[0]?.content);
    });

    it("falls back to skill name for description when omitted", async () => {
      const files = await adapter.generate([
        { id: "debug", name: "Debug", content: "Inspect logs." },
      ]);
      expect(files[0]?.content).toContain("description: Debug");
      expect(files[0]?.content).toContain("invokable: true");
    });

    it("handles empty skills array", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });
  });

  describe("import", () => {
    it("returns empty array when neither skills nor prompts dir exists", async () => {
      expect(await adapter.import(tmp)).toEqual([]);
    });

    it("round-trips skills from .continue/skills/<id>/SKILL.md including CRLF frontmatter", async () => {
      const files = await adapter.generate([testSkill]);
      await adapter.install(files, tmp);

      await mkdir(join(tmp, ".continue/skills/win-skill"), { recursive: true });
      await writeFile(
        join(tmp, ".continue/skills/win-skill/SKILL.md"),
        '---\r\nname: "Win Skill"\r\ndescription: "CRLF: test"\r\ninvokable: true\r\n---\r\n\r\nLine A\r\nLine B\r\n',
        "utf-8",
      );

      const imported = await adapter.import(tmp);
      const byId = new Map(imported.map((s) => [s.id, s]));

      expect(byId.get("review")).toEqual(testSkill);
      expect(byId.get("win-skill")).toEqual({
        id: "win-skill",
        name: "Win Skill",
        description: "CRLF: test",
        content: "Line A\nLine B",
      });
    });

    it("falls back to legacy .continue/prompts/*.md without duplicating existing skill IDs", async () => {
      await adapter.install(await adapter.generate([testSkill]), tmp);

      const promptsDir = join(tmp, ".continue/prompts");
      await mkdir(promptsDir, { recursive: true });
      await writeFile(join(promptsDir, "review.md"), "# Duplicate\n\nIgnored\n", "utf-8");
      await writeFile(
        join(promptsDir, "legacy.md"),
        "# Legacy Prompt\r\n\r\nOld format.\r\n",
        "utf-8",
      );
      await writeFile(join(promptsDir, "ignore.txt"), "not markdown", "utf-8");

      const imported = await adapter.import(tmp);
      expect(imported).toHaveLength(2);
      const byId = new Map(imported.map((s) => [s.id, s]));
      expect(byId.get("review")?.name).toBe("Code Review");
      expect(byId.get("legacy")).toEqual({
        id: "legacy",
        name: "Legacy Prompt",
        content: "Old format.",
      });
    });
  });

  describe("detect & uninstall", () => {
    it("detects .continue/skills directory or cn binary", async () => {
      expect(await adapter.detect(tmp)).toBe(false);
      await mkdir(join(tmp, ".continue/skills"), { recursive: true });
      expect(await adapter.detect(tmp)).toBe(true);

      await rm(join(tmp, ".continue"), { recursive: true, force: true });
      vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
        (cb as (error: Error | null) => void)(null);
      }) as typeof execFile);
      expect(await adapter.detect(tmp)).toBe(true);
    });

    it("removes .continue/skills on uninstall and is safe when missing", async () => {
      await adapter.uninstall(tmp);
      await adapter.install(await adapter.generate([testSkill]), tmp);
      expect(existsSync(join(tmp, ".continue/skills/review/SKILL.md"))).toBe(true);

      await adapter.uninstall(tmp);
      expect(existsSync(join(tmp, ".continue/skills"))).toBe(false);
    });
  });
});
