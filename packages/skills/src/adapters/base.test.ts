import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { BaseSkillAdapter } from "./base.js";
import type { SkillDefinition, GeneratedFile } from "../types/index.js";

// Concrete subclass for testing the abstract BaseSkillAdapter
class TestSkillAdapter extends BaseSkillAdapter {
  readonly id = "test-skills";
  readonly name = "Test Skills";
  readonly nativeSupport = true;
  readonly configDir = ".test/prompts";

  async generate(skills: SkillDefinition[]): Promise<GeneratedFile[]> {
    return skills.map((s) => ({
      path: `.test/prompts/${s.id}.md`,
      content: `# ${s.name}\n\n${s.content}\n`,
      format: "md" as const,
    }));
  }

  async import(_cwd?: string): Promise<SkillDefinition[]> {
    return [];
  }
}

// Mock node:fs and node:fs/promises
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

// Import mocked modules so we can control them
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";

const mockedExistsSync = vi.mocked(existsSync);
const mockedWriteFile = vi.mocked(writeFile);
const mockedMkdir = vi.mocked(mkdir);

describe("BaseSkillAdapter", () => {
  let adapter: TestSkillAdapter;

  beforeEach(() => {
    adapter = new TestSkillAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("abstract properties", () => {
    it("exposes id, name, nativeSupport, and configDir", () => {
      expect(adapter.id).toBe("test-skills");
      expect(adapter.name).toBe("Test Skills");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".test/prompts");
    });
  });

  describe("detect()", () => {
    it("returns true when configDir exists", async () => {
      mockedExistsSync.mockReturnValue(true);
      const result = await adapter.detect();
      expect(result).toBe(true);
    });

    it("returns false when configDir does not exist", async () => {
      mockedExistsSync.mockReturnValue(false);
      const result = await adapter.detect();
      expect(result).toBe(false);
    });

    it("uses provided cwd to resolve configDir", async () => {
      mockedExistsSync.mockReturnValue(true);
      await adapter.detect("/custom/dir");
      expect(mockedExistsSync).toHaveBeenCalledWith(expect.stringContaining(join("custom", "dir")));
    });

    it("uses process.cwd() when no cwd is provided", async () => {
      mockedExistsSync.mockReturnValue(false);
      await adapter.detect();
      expect(mockedExistsSync).toHaveBeenCalledWith(
        expect.stringContaining(join(".test", "prompts")),
      );
    });
  });

  describe("generate()", () => {
    it("calls the subclass implementation with skills", async () => {
      const skills: SkillDefinition[] = [
        { id: "review", name: "Code Review", content: "Review the code" },
      ];
      const files = await adapter.generate(skills);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".test/prompts/review.md");
      expect(files[0]?.content).toContain("Code Review");
    });

    it("handles empty skills array", async () => {
      const files = await adapter.generate([]);
      expect(files).toHaveLength(0);
    });
  });

  describe("install()", () => {
    it("writes all files to disk", async () => {
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const files: GeneratedFile[] = [
        { path: ".prompts/skill1.md", content: "# Skill 1", format: "md" },
        { path: ".prompts/skill2.md", content: "# Skill 2", format: "md" },
      ];

      await adapter.install(files);

      expect(mockedMkdir).toHaveBeenCalledTimes(2);
      expect(mockedWriteFile).toHaveBeenCalledTimes(2);
      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.stringContaining("skill1.md"),
        "# Skill 1",
        "utf-8",
      );
    });

    it("creates parent directories recursively", async () => {
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const files: GeneratedFile[] = [
        { path: "deep/nested/dir/skill.md", content: "test", format: "md" },
      ];

      await adapter.install(files);

      expect(mockedMkdir).toHaveBeenCalledWith(
        expect.stringContaining(join("deep", "nested", "dir")),
        {
          recursive: true,
        },
      );
    });

    it("handles empty file array", async () => {
      await adapter.install([]);
      expect(mockedMkdir).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it("uses provided cwd to resolve file paths", async () => {
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const files: GeneratedFile[] = [{ path: "skill.md", content: "test", format: "md" }];

      await adapter.install(files, "/custom/project");

      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(resolve("/custom/project")),
        "test",
        "utf-8",
      );
    });
  });

  describe("uninstall()", () => {
    it("is a no-op by default", async () => {
      // Default implementation does nothing; subclasses override
      await adapter.uninstall();
      // No error thrown means it worked
    });
  });
});
