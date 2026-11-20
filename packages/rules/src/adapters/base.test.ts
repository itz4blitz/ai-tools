import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join, resolve } from "node:path";
import { BaseRuleAdapter } from "./base.js";
import type { RuleDefinition, GeneratedFile } from "../types/index.js";

// Concrete subclass for testing the abstract BaseRuleAdapter
class TestRuleAdapter extends BaseRuleAdapter {
  readonly id = "test-rules";
  readonly name = "Test Rules";
  readonly nativeSupport = true;
  readonly configDir = ".test/rules";

  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    return rules.map((r) => ({
      path: `.test/rules/${r.id}.md`,
      content: `# ${r.name}\n\n${r.content}\n`,
      format: "md" as const,
    }));
  }

  async import(_cwd?: string): Promise<RuleDefinition[]> {
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

describe("BaseRuleAdapter", () => {
  let adapter: TestRuleAdapter;

  beforeEach(() => {
    adapter = new TestRuleAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("abstract properties", () => {
    it("exposes id, name, nativeSupport, and configDir", () => {
      expect(adapter.id).toBe("test-rules");
      expect(adapter.name).toBe("Test Rules");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".test/rules");
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
        expect.stringContaining(join(".test", "rules")),
      );
    });

    it("falls back to commandExists via execFile when configDir is missing", async () => {
      mockedExistsSync.mockReturnValue(false);
      class NodeRuleAdapter extends TestRuleAdapter {
        override readonly command = "node";
      }
      class MissingRuleAdapter extends TestRuleAdapter {
        override readonly command = "definitely-not-a-real-binary-xyz-987654";
      }
      expect(await new NodeRuleAdapter().detect()).toBe(true);
      expect(await new MissingRuleAdapter().detect()).toBe(false);
    });
  });

  describe("generate()", () => {
    it("calls the subclass implementation with rules", async () => {
      const rules: RuleDefinition[] = [
        {
          id: "typescript",
          name: "TypeScript Standards",
          content: "Use strict TypeScript",
          scope: { type: "always" },
        },
      ];
      const files = await adapter.generate(rules);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".test/rules/typescript.md");
      expect(files[0]?.content).toContain("TypeScript Standards");
    });

    it("handles empty rules array", async () => {
      const files = await adapter.generate([]);
      expect(files).toHaveLength(0);
    });
  });

  describe("install()", () => {
    it("writes all files to disk", async () => {
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const files: GeneratedFile[] = [
        { path: ".rules/rule1.md", content: "# Rule 1", format: "md" },
        { path: ".rules/rule2.md", content: "# Rule 2", format: "md" },
      ];

      await adapter.install(files);

      expect(mockedMkdir).toHaveBeenCalledTimes(2);
      expect(mockedWriteFile).toHaveBeenCalledTimes(2);
      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.stringContaining("rule1.md"),
        "# Rule 1",
        "utf-8",
      );
    });

    it("creates parent directories recursively", async () => {
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const files: GeneratedFile[] = [
        { path: "deep/nested/dir/rule.md", content: "test", format: "md" },
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

      const files: GeneratedFile[] = [{ path: "rule.md", content: "test", format: "md" }];

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
