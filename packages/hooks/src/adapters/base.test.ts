import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { BaseAdapter } from "./base.js";
import type {
  AdapterCapabilities,
  GeneratedConfig,
  HookDefinition,
  HookEventType,
} from "../types/index.js";

// Concrete subclass for testing the abstract BaseAdapter
class TestAdapter extends BaseAdapter {
  readonly id = "test-adapter";
  readonly name = "Test Adapter";
  readonly version = "1.0.0";
  readonly capabilities: AdapterCapabilities = {
    beforeHooks: true,
    afterHooks: true,
    mcp: false,
    configFile: true,
    supportedEvents: ["shell:before", "file:write"],
    blockableEvents: ["shell:before"],
  };

  async detect(): Promise<boolean> {
    return true;
  }

  async generate(hooks: HookDefinition[]): Promise<GeneratedConfig[]> {
    return hooks.map((h) => ({
      path: `hooks/${h.id}.json`,
      content: JSON.stringify({ id: h.id }),
      format: "json" as const,
    }));
  }

  mapEvent(event: HookEventType): string[] {
    const map: Partial<Record<HookEventType, string[]>> = {
      "shell:before": ["PreToolUse"],
      "file:write": ["PreToolUse"],
    };
    return map[event] ?? [];
  }

  mapNativeEvent(nativeEvent: string): HookEventType[] {
    if (nativeEvent === "PreToolUse") return ["shell:before", "file:write"];
    return [];
  }

  // Expose protected methods for testing
  publicFileExists(path: string): Promise<boolean> {
    return this.fileExists(path);
  }

  publicReadJsonFile<T>(path: string): Promise<T | null> {
    return this.readJsonFile<T>(path);
  }

  publicWriteJsonFile(path: string, data: unknown): Promise<void> {
    return this.writeJsonFile(path, data);
  }

  publicRemoveFile(path: string): Promise<void> {
    return this.removeFile(path);
  }

  publicCommandExists(command: string): Promise<boolean> {
    return this.commandExists(command);
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

describe("BaseAdapter", () => {
  let adapter: TestAdapter;

  beforeEach(() => {
    adapter = new TestAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("abstract properties", () => {
    it("exposes id, name, version, and capabilities", () => {
      expect(adapter.id).toBe("test-adapter");
      expect(adapter.name).toBe("Test Adapter");
      expect(adapter.version).toBe("1.0.0");
      expect(adapter.capabilities.beforeHooks).toBe(true);
      expect(adapter.capabilities.afterHooks).toBe(true);
      expect(adapter.capabilities.mcp).toBe(false);
      expect(adapter.capabilities.configFile).toBe(true);
      expect(adapter.capabilities.supportedEvents).toEqual(["shell:before", "file:write"]);
      expect(adapter.capabilities.blockableEvents).toEqual(["shell:before"]);
    });
  });

  describe("detect()", () => {
    it("calls the subclass implementation", async () => {
      const result = await adapter.detect();
      expect(result).toBe(true);
    });
  });

  describe("generate()", () => {
    it("calls the subclass implementation with hooks", async () => {
      const hooks: HookDefinition[] = [
        {
          id: "h1",
          name: "Hook 1",
          events: ["shell:before"],
          phase: "before",
          handler: async () => {},
        },
      ];
      const configs = await adapter.generate(hooks);
      expect(configs).toHaveLength(1);
      expect(configs[0]?.path).toBe("hooks/h1.json");
      expect(configs[0]?.content).toBe(JSON.stringify({ id: "h1" }));
    });
  });

  describe("mapEvent()", () => {
    it("maps known events", () => {
      expect(adapter.mapEvent("shell:before")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("file:write")).toEqual(["PreToolUse"]);
    });

    it("returns empty array for unknown events", () => {
      expect(adapter.mapEvent("session:start")).toEqual([]);
    });
  });

  describe("mapNativeEvent()", () => {
    it("maps known native events", () => {
      expect(adapter.mapNativeEvent("PreToolUse")).toEqual(["shell:before", "file:write"]);
    });

    it("returns empty array for unknown native events", () => {
      expect(adapter.mapNativeEvent("UnknownEvent")).toEqual([]);
    });
  });

  describe("install()", () => {
    it("writes all config files to disk", async () => {
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const configs: GeneratedConfig[] = [
        { path: ".hooks/config.json", content: '{"hooks":[]}', format: "json" },
        { path: ".hooks/rules.json", content: '{"rules":[]}', format: "json" },
      ];

      await adapter.install(configs);

      expect(mockedMkdir).toHaveBeenCalledTimes(2);
      expect(mockedWriteFile).toHaveBeenCalledTimes(2);
      // Verify file content is written correctly
      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.stringContaining("config.json"),
        '{"hooks":[]}',
        "utf-8",
      );
      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.stringContaining("rules.json"),
        '{"rules":[]}',
        "utf-8",
      );
    });

    it("creates parent directories recursively", async () => {
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const configs: GeneratedConfig[] = [
        { path: "deep/nested/dir/config.json", content: "{}", format: "json" },
      ];

      await adapter.install(configs);

      expect(mockedMkdir).toHaveBeenCalledWith(
        expect.stringContaining(join("deep", "nested", "dir")),
        {
          recursive: true,
        },
      );
    });

    it("handles empty config array", async () => {
      await adapter.install([]);
      expect(mockedMkdir).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });
  });

  describe("uninstall()", () => {
    it("is a no-op by default", async () => {
      await adapter.uninstall();
      // Default implementation does nothing; subclasses override
      expect(mockedRm).not.toHaveBeenCalled();
    });
  });

  describe("fileExists()", () => {
    it("returns true when file exists", async () => {
      mockedExistsSync.mockReturnValue(true);
      const result = await adapter.publicFileExists("package.json");
      expect(result).toBe(true);
      expect(mockedExistsSync).toHaveBeenCalledWith(expect.stringContaining("package.json"));
    });

    it("returns false when file does not exist", async () => {
      mockedExistsSync.mockReturnValue(false);
      const result = await adapter.publicFileExists("nonexistent.json");
      expect(result).toBe(false);
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

  describe("writeJsonFile()", () => {
    it("writes formatted JSON with trailing newline", async () => {
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      const data = { hooks: ["a", "b"], enabled: true };
      await adapter.publicWriteJsonFile("config/output.json", data);

      expect(mockedMkdir).toHaveBeenCalledWith(expect.stringContaining("config"), {
        recursive: true,
      });
      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.stringContaining("output.json"),
        JSON.stringify(data, null, 2) + "\n",
        "utf-8",
      );
    });

    it("creates parent directories", async () => {
      mockedMkdir.mockResolvedValue(undefined);
      mockedWriteFile.mockResolvedValue(undefined);

      await adapter.publicWriteJsonFile("a/b/c.json", {});

      expect(mockedMkdir).toHaveBeenCalledWith(expect.stringContaining(join("a", "b")), {
        recursive: true,
      });
    });
  });

  describe("removeFile()", () => {
    it("removes file when it exists", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedRm.mockResolvedValue(undefined);

      await adapter.publicRemoveFile("old-config.json");

      expect(mockedRm).toHaveBeenCalledWith(expect.stringContaining("old-config.json"));
    });

    it("does nothing when file does not exist", async () => {
      mockedExistsSync.mockReturnValue(false);

      await adapter.publicRemoveFile("nonexistent.json");

      expect(mockedRm).not.toHaveBeenCalled();
    });
  });

  describe("commandExists()", () => {
    it("returns true when command is found on PATH", async () => {
      // "node" is guaranteed to exist in the test environment
      const result = await adapter.publicCommandExists("node");
      expect(result).toBe(true);
    });

    it("returns false when command is not found on PATH", async () => {
      const result = await adapter.publicCommandExists("nonexistent-binary-xyz-99999");
      expect(result).toBe(false);
    });
  });
});
