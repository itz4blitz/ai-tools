import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BaseMCPAdapter } from "./base.js";
import type { MCPServerDefinition, GeneratedFile } from "../types/index.js";

// Concrete subclass for testing the abstract BaseMCPAdapter
class TestMCPAdapter extends BaseMCPAdapter {
  readonly id = "test-mcp";
  readonly name = "Test MCP";
  readonly nativeSupport = true;
  readonly configPath = ".test/mcp.json";

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    return servers.map((s) => ({
      path: `.test/${s.id}.json`,
      content: JSON.stringify(s),
      format: "json" as const,
    }));
  }

  async import(_cwd?: string): Promise<MCPServerDefinition[]> {
    return [];
  }

  // Expose protected methods for testing
  publicReadJsonFile<T>(path: string): Promise<T | null> {
    return this.readJsonFile<T>(path);
  }
}

// Mock node:fs and node:fs/promises
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));

// Import mocked modules so we can control them
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedMkdir = vi.mocked(mkdir);
const mockedRm = vi.mocked(rm);

describe("BaseMCPAdapter", () => {
  let adapter: TestMCPAdapter;

  beforeEach(() => {
    adapter = new TestMCPAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("abstract properties", () => {
    it("exposes id, name, nativeSupport, and configPath", () => {
      expect(adapter.id).toBe("test-mcp");
      expect(adapter.name).toBe("Test MCP");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configPath).toBe(".test/mcp.json");
    });
  });

  describe("detect()", () => {
    it("returns true when config file exists", async () => {
      mockedExistsSync.mockReturnValue(true);
      const result = await adapter.detect();
      expect(result).toBe(true);
    });

    it("returns false when config file does not exist", async () => {
      mockedExistsSync.mockReturnValue(false);
      const result = await adapter.detect();
      expect(result).toBe(false);
    });

    it("uses provided cwd to resolve config path", async () => {
      mockedExistsSync.mockReturnValue(true);
      await adapter.detect("/custom/dir");
      expect(mockedExistsSync).toHaveBeenCalledWith(expect.stringContaining(join("custom", "dir")));
    });

    it("uses process.cwd() when no cwd is provided", async () => {
      mockedExistsSync.mockReturnValue(false);
      await adapter.detect();
      expect(mockedExistsSync).toHaveBeenCalledWith(
        expect.stringContaining(join(".test", "mcp.json")),
      );
    });
  });

  describe("generate()", () => {
    it("calls the subclass implementation with servers", async () => {
      const servers: MCPServerDefinition[] = [
        {
          id: "test-server",
          name: "Test Server",
          transport: { type: "stdio", command: "npx", args: ["-y", "test"] },
        },
      ];
      const files = await adapter.generate(servers);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".test/test-server.json");
    });

    it("handles empty servers array", async () => {
      const files = await adapter.generate([]);
      expect(files).toHaveLength(0);
    });
  });

  describe("install()", () => {
    it("writes all files to disk", async () => {
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const files: GeneratedFile[] = [
        { path: ".mcp/config.json", content: '{"servers":{}}', format: "json" },
        { path: ".mcp/settings.json", content: '{"enabled":true}', format: "json" },
      ];

      await adapter.install(files);

      expect(mockedMkdir).toHaveBeenCalledTimes(2);
      expect(mockedWriteFile).toHaveBeenCalledTimes(2);
      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.stringContaining("config.json"),
        '{"servers":{}}',
        "utf-8",
      );
      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.stringContaining("settings.json"),
        '{"enabled":true}',
        "utf-8",
      );
    });

    it("creates parent directories recursively", async () => {
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const files: GeneratedFile[] = [
        { path: "deep/nested/dir/config.json", content: "{}", format: "json" },
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

      const files: GeneratedFile[] = [{ path: "config.json", content: "{}", format: "json" }];

      await adapter.install(files, "/custom/project");

      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.stringContaining(join("custom", "project")),
        "{}",
        "utf-8",
      );
    });
  });

  describe("uninstall()", () => {
    it("removes config file when it exists", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedRm.mockResolvedValue(undefined);

      await adapter.uninstall();

      expect(mockedRm).toHaveBeenCalledWith(expect.stringContaining(join(".test", "mcp.json")));
    });

    it("does nothing when config file does not exist", async () => {
      mockedExistsSync.mockReturnValue(false);

      await adapter.uninstall();

      expect(mockedRm).not.toHaveBeenCalled();
    });

    it("uses provided cwd to resolve config path", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedRm.mockResolvedValue(undefined);

      await adapter.uninstall("/custom/dir");

      expect(mockedExistsSync).toHaveBeenCalledWith(expect.stringContaining(join("custom", "dir")));
    });
  });

  describe("readJsonFile()", () => {
    it("returns parsed JSON when file exists", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFile.mockResolvedValue('{"name":"test","version":"1.0"}');

      const result = await adapter.publicReadJsonFile<{ name: string; version: string }>(
        "package.json",
      );

      expect(result).toEqual({ name: "test", version: "1.0" });
    });

    it("returns null when file does not exist", async () => {
      mockedExistsSync.mockReturnValue(false);

      const result = await adapter.publicReadJsonFile("missing.json");

      expect(result).toBeNull();
      expect(mockedReadFile).not.toHaveBeenCalled();
    });

    it("reads file with utf-8 encoding", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFile.mockResolvedValue("{}");

      await adapter.publicReadJsonFile("file.json");

      expect(mockedReadFile).toHaveBeenCalledWith(expect.any(String), "utf-8");
    });
  });
});
