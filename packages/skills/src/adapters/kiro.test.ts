import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KiroSkillAdapter } from "./kiro.js";
import type { SkillDefinition } from "../types/index.js";

describe("KiroSkillAdapter", () => {
  let adapter: KiroSkillAdapter;
  let tempDir: string;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Code Review",
    description: "Review code for best practices",
    content: "Please review the selected code for security and performance.",
  };

  beforeEach(async () => {
    adapter = new KiroSkillAdapter();
    tempDir = await mkdtemp(join(tmpdir(), "kiro-skills-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct id, name, nativeSupport, configDir, and userConfigDir", () => {
      expect(adapter.id).toBe("kiro");
      expect(adapter.name).toBe("Kiro");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".kiro/skills");
      expect(adapter.userConfigDir).toBe(".kiro/skills");
      expect(adapter.skillsDir("project")).toBe(".kiro/skills");
      expect(adapter.skillsDir("user")).toBe(".kiro/skills");
    });
  });

  describe("generate", () => {
    it("generates .kiro/skills/<id>/SKILL.md with YAML frontmatter", async () => {
      const files = await adapter.generate([testSkill]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".kiro/skills/review/SKILL.md");
      expect(files[0]!.format).toBe("md");
      expect(files[0]!.content).toBe(
        "---\nname: review\ndescription: Review code for best practices\n---\n\nPlease review the selected code for security and performance.\n",
      );
    });

    it("copies supporting files when sourceDir is provided", async () => {
      const srcDir = join(tempDir, "src-skill");
      await mkdir(join(srcDir, "scripts"), { recursive: true });
      await writeFile(join(srcDir, "SKILL.md"), "---\nname: bundled\n---\n\nBody\n", "utf-8");
      await writeFile(join(srcDir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n", "utf-8");

      const files = await adapter.generate([
        { id: "bundled", name: "Bundled", content: "Body", sourceDir: srcDir },
      ]);
      expect(files.map((f) => f.path).toSorted()).toEqual([
        ".kiro/skills/bundled/SKILL.md",
        ".kiro/skills/bundled/scripts/run.sh",
      ]);
    });
  });

  describe("install, import, and uninstall", () => {
    it("round-trips skills and supports CRLF SKILL.md frontmatter", async () => {
      const files = await adapter.generate([testSkill]);
      await adapter.install(files, tempDir);

      // Write a CRLF skill manually
      const crlfDir = join(tempDir, ".kiro", "skills", "crlf-skill");
      await mkdir(crlfDir, { recursive: true });
      await writeFile(
        join(crlfDir, "SKILL.md"),
        "---\r\nname: crlf-skill\r\ndescription: Windows line endings\r\n---\r\n\r\nLine 1\r\nLine 2\r\n",
        "utf-8",
      );

      // Non-skill directory should be skipped
      await mkdir(join(tempDir, ".kiro", "skills", "not-a-skill"), { recursive: true });

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(2);

      const review = imported.find((s) => s.id === "review");
      expect(review).toEqual({
        id: "review",
        name: "review",
        description: "Review code for best practices",
        content: "Please review the selected code for security and performance.",
      });

      const crlf = imported.find((s) => s.id === "crlf-skill");
      expect(crlf).toEqual({
        id: "crlf-skill",
        name: "crlf-skill",
        description: "Windows line endings",
        content: "Line 1\nLine 2",
      });
    });

    it("uninstall removes skill directories and cleans up empty .kiro/skills", async () => {
      const files = await adapter.generate([testSkill]);
      await adapter.install(files, tempDir);
      expect(existsSync(join(tempDir, ".kiro", "skills", "review", "SKILL.md"))).toBe(true);

      await adapter.uninstall(tempDir);
      expect(existsSync(join(tempDir, ".kiro", "skills"))).toBe(false);
    });

    it("returns empty array when skills dir does not exist", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });
  });

  describe("detect", () => {
    it("detects .kiro/skills dir or kiro / kiro-cli binaries", async () => {
      const spy = vi
        .spyOn(
          adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
          "commandExists",
        )
        .mockImplementation(async (cmd) => cmd === "kiro-cli");

      expect(await adapter.detect(tempDir)).toBe(true);
      expect(spy).toHaveBeenCalledWith("kiro");
      expect(spy).toHaveBeenCalledWith("kiro-cli");

      spy.mockResolvedValue(false);
      expect(await adapter.detect(tempDir)).toBe(false);

      await mkdir(join(tempDir, ".kiro", "skills"), { recursive: true });
      expect(await adapter.detect(tempDir)).toBe(true);
    });
  });
});
