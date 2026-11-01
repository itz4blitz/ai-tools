import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { GeminiCliMCPAdapter } from "./gemini-cli.js";
import type { MCPServerDefinition } from "../types/index.js";

describe("GeminiCliMCPAdapter", () => {
  let adapter: GeminiCliMCPAdapter;

  const testServer: MCPServerDefinition = {
    id: "test-server",
    name: "Test Server",
    transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { KEY: "val" } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new GeminiCliMCPAdapter();
  });

  describe("metadata", () => {
    it("has correct id", () => expect(adapter.id).toBe("gemini-cli"));
    it("has correct name", () => expect(adapter.name).toBe("Gemini CLI"));
    it("has native support", () => expect(adapter.nativeSupport).toBe(true));
    it("has correct config path", () => expect(adapter.configPath).toBe(".gemini/settings.json"));
    it("has user config path ~/.gemini/settings.json", () => {
      expect(adapter.userConfigPath).toMatch(/\.gemini\/settings\.json$/);
    });
  });

  describe("generate", () => {
    it("generates valid JSON config with env", async () => {
      const files = await adapter.generate([testServer]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".gemini/settings.json");
      expect(files[0]!.format).toBe("json");
      const parsed = JSON.parse(files[0]!.content);
      expect(parsed.mcpServers["test-server"]).toBeDefined();
      expect(parsed.mcpServers["test-server"].command).toBe("npx");
      expect(parsed.mcpServers["test-server"].args).toEqual(["-y", "test-mcp"]);
      expect(parsed.mcpServers["test-server"].env).toEqual({ KEY: "val" });
    });

    it("handles SSE transport", async () => {
      const sseServer: MCPServerDefinition = {
        id: "sse-server",
        name: "SSE Server",
        transport: { type: "sse", url: "http://localhost:3000" },
      };
      const files = await adapter.generate([sseServer]);
      const parsed = JSON.parse(files[0]!.content);
      expect(parsed.mcpServers["sse-server"].url).toBe("http://localhost:3000");
    });

    it("writes HTTP remotes as httpUrl (streamable HTTP)", async () => {
      const httpServer: MCPServerDefinition = {
        id: "krisp",
        name: "Krisp",
        transport: { type: "http", url: "https://mcp.krisp.ai/mcp" },
      };
      const files = await adapter.generate([httpServer]);
      const parsed = JSON.parse(files[0]!.content);
      expect(parsed.mcpServers.krisp).toEqual({ httpUrl: "https://mcp.krisp.ai/mcp", headers: {} });
    });

    it("handles empty servers array", async () => {
      const files = await adapter.generate([]);
      const parsed = JSON.parse(files[0]!.content);
      expect(Object.keys(parsed.mcpServers)).toHaveLength(0);
    });

    it("handles multiple servers", async () => {
      const servers = [testServer, { ...testServer, id: "server-2", name: "Server 2" }];
      const files = await adapter.generate(servers);
      const parsed = JSON.parse(files[0]!.content);
      expect(Object.keys(parsed.mcpServers)).toHaveLength(2);
    });

    it("generates with optional fields undefined", async () => {
      const server: MCPServerDefinition = {
        id: "minimal",
        name: "Minimal",
        transport: { type: "stdio", command: "node" },
      };
      const files = await adapter.generate([server]);
      const parsed = JSON.parse(files[0]!.content);
      expect(parsed.mcpServers["minimal"].args).toEqual([]);
      expect(parsed.mcpServers["minimal"].env).toBeUndefined();
    });
  });

  describe("install", () => {
    it("merges into an existing settings.json instead of overwriting it", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          security: { auth: { selectedType: "oauth-personal" } },
          mcpServers: { existing: { command: "keep-me" } },
        }),
      );
      const files = await adapter.generate([testServer]);
      await adapter.install(files, "/home/user");
      const written = JSON.parse(vi.mocked(writeFile).mock.calls[0]![1] as string);
      expect(written.security).toEqual({ auth: { selectedType: "oauth-personal" } });
      expect(written.mcpServers.existing).toEqual({ command: "keep-me" });
      expect(written.mcpServers["test-server"].env).toEqual({ KEY: "val" });
    });

    it("writes the generated file when none exists", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const files = await adapter.generate([testServer]);
      await adapter.install(files, "/home/user");
      expect(vi.mocked(readFile)).not.toHaveBeenCalled();
      expect(vi.mocked(writeFile).mock.calls[0]![1]).toBe(files[0]!.content);
    });
  });

  describe("import", () => {
    it("returns empty array when file does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const result = await adapter.import("/test");
      expect(result).toEqual([]);
    });

    it("imports stdio servers from config", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          mcpServers: { "my-server": { command: "npx", args: ["-y", "test"], env: { A: "1" } } },
        }),
      );
      const result = await adapter.import("/test");
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe("my-server");
      expect(result[0]!.transport).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "test"],
        env: { A: "1" },
      });
    });

    it("imports SSE servers from config", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          mcpServers: { sse: { url: "http://localhost:3000" } },
        }),
      );
      const result = await adapter.import("/test");
      expect(result).toHaveLength(1);
      expect(result[0]!.transport.type).toBe("sse");
    });

    it("imports httpUrl servers as http", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({ mcpServers: { krisp: { httpUrl: "https://mcp.krisp.ai/mcp" } } }),
      );
      const result = await adapter.import("/test");
      expect(result[0]!.transport).toEqual({
        type: "http",
        url: "https://mcp.krisp.ai/mcp",
        headers: undefined,
      });
    });

    it("imports with missing servers key", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify({}));
      const result = await adapter.import("/test");
      expect(result).toEqual([]);
    });

    it("imports without cwd argument", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const result = await adapter.import();
      expect(result).toEqual([]);
    });
  });
});
