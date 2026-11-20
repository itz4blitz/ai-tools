import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockHome } = vi.hoisted(() => ({
  mockHome: { current: "" },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHome.current || actual.homedir(),
  };
});

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { CursorMCPAdapter } from "./cursor.js";
import type { MCPServerDefinition } from "../types/index.js";

describe("CursorMCPAdapter", () => {
  let adapter: CursorMCPAdapter;
  let tempDir: string;
  let tempHome: string;

  const testServer: MCPServerDefinition = {
    id: "test-server",
    name: "Test Server",
    transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { KEY: "val" } },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-mcp-cursor-"));
    tempHome = await mkdtemp(join(tmpdir(), "ai-tools-mcp-cursor-home-"));
    mockHome.current = tempHome;
    adapter = new CursorMCPAdapter();
  });

  afterEach(async () => {
    mockHome.current = "";
    await rm(tempDir, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct metadata and OS-native userConfigPath", () => {
      expect(adapter.id).toBe("cursor");
      expect(adapter.name).toBe("Cursor");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configPath).toBe(".cursor/mcp.json");
      expect(adapter.userConfigPath).toBe(join(tempHome, ".cursor", "mcp.json"));
    });
  });

  describe("generate", () => {
    it("generates valid JSON config for stdio, sse, and http transports", async () => {
      const servers: MCPServerDefinition[] = [
        testServer,
        {
          id: "sse-server",
          name: "SSE Server",
          transport: { type: "sse", url: "http://localhost:3000" },
        },
        {
          id: "http-server",
          name: "HTTP Server",
          transport: {
            type: "http",
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: "Bearer x" },
          },
        },
      ];
      const files = await adapter.generate(servers);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".cursor/mcp.json");
      expect(files[0]!.format).toBe("json");
      const parsed = JSON.parse(files[0]!.content) as {
        mcpServers: Record<string, Record<string, unknown>>;
      };
      expect(parsed.mcpServers["test-server"]?.command).toBe("npx");
      expect(parsed.mcpServers["sse-server"]?.type).toBe("sse");
      expect(parsed.mcpServers["http-server"]).toEqual({
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer x" },
      });
    });

    it("handles empty servers array", async () => {
      const files = await adapter.generate([]);
      const parsed = JSON.parse(files[0]!.content) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(parsed.mcpServers)).toHaveLength(0);
    });
  });

  describe("detect", () => {
    it("detects ~/.cursor/mcp.json when project config is absent", async () => {
      await mkdir(join(tempHome, ".cursor"), { recursive: true });
      await writeFile(join(tempHome, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));
      expect(await adapter.detect(tempDir)).toBe(true);
    });

    it("detects project .cursor/mcp.json", async () => {
      await mkdir(join(tempDir, ".cursor"), { recursive: true });
      await writeFile(join(tempDir, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));
      expect(await adapter.detect(tempDir)).toBe(true);
    });
  });

  describe("install, import, and non-destructive uninstall", () => {
    it("merges into existing .cursor/mcp.json preserving user servers and extra keys", async () => {
      await mkdir(join(tempDir, ".cursor"), { recursive: true });
      await writeFile(
        join(tempDir, ".cursor/mcp.json"),
        JSON.stringify(
          {
            customSetting: "keep-me",
            mcpServers: {
              "user-server": { command: "python", args: ["server.py"] },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const files = await adapter.generate([testServer]);
      await adapter.install(files, tempDir);

      const merged = JSON.parse(await readFile(join(tempDir, ".cursor/mcp.json"), "utf-8")) as {
        customSetting: string;
        mcpServers: Record<string, unknown>;
      };
      expect(merged.customSetting).toBe("keep-me");
      expect(merged.mcpServers["user-server"]).toBeDefined();
      expect(merged.mcpServers["test-server"]).toBeDefined();

      // Round-trip import
      const imported = await adapter.import(tempDir);
      expect(imported.map((s) => s.id).toSorted()).toEqual(["test-server", "user-server"]);

      // Non-destructive selective uninstall removes only specified serverIds
      await adapter.uninstall(tempDir, ["test-server"]);
      expect(existsSync(join(tempDir, ".cursor/mcp.json"))).toBe(true);

      const afterSelective = JSON.parse(
        await readFile(join(tempDir, ".cursor/mcp.json"), "utf-8"),
      ) as {
        customSetting: string;
        mcpServers: Record<string, unknown>;
      };
      expect(afterSelective.customSetting).toBe("keep-me");
      expect(afterSelective.mcpServers["user-server"]).toBeDefined();
      expect(afterSelective.mcpServers["test-server"]).toBeUndefined();

      // Full uninstall preserves extra top-level keys when present
      await adapter.uninstall(tempDir);
      expect(existsSync(join(tempDir, ".cursor/mcp.json"))).toBe(true);
      const afterFull = JSON.parse(await readFile(join(tempDir, ".cursor/mcp.json"), "utf-8")) as {
        customSetting: string;
        mcpServers?: Record<string, unknown>;
      };
      expect(afterFull.customSetting).toBe("keep-me");
      expect(afterFull.mcpServers).toBeUndefined();
    });

    it("removes .cursor/mcp.json when uninstall leaves no servers and no extra keys", async () => {
      const files = await adapter.generate([testServer]);
      await adapter.install(files, tempDir);
      expect(existsSync(join(tempDir, ".cursor/mcp.json"))).toBe(true);

      await adapter.uninstall(tempDir, ["test-server"]);
      expect(existsSync(join(tempDir, ".cursor/mcp.json"))).toBe(false);
    });

    it("returns empty array when config file does not exist", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });
  });
});
