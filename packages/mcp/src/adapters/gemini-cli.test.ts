import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiCliMCPAdapter } from "./gemini-cli.js";
import type { MCPServerDefinition } from "../types/index.js";

describe("GeminiCliMCPAdapter", () => {
  let adapter: GeminiCliMCPAdapter;
  let tempDir: string;

  const testServer: MCPServerDefinition = {
    id: "test-server",
    name: "Test Server",
    transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { KEY: "val" } },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-gemini-mcp-"));
    adapter = new GeminiCliMCPAdapter();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct metadata and cross-platform userConfigPath", () => {
      expect(adapter.id).toBe("gemini-cli");
      expect(adapter.name).toBe("Gemini CLI");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configPath).toBe(".gemini/settings.json");
      expect(adapter.userConfigPath).toMatch(/[/\\]\.gemini[/\\]settings\.json$/);
    });
  });

  describe("generate", () => {
    it("generates stdio config with env when non-empty and omits env when empty", async () => {
      const files = await adapter.generate([
        testServer,
        { id: "minimal", name: "Minimal", transport: { type: "stdio", command: "node" } },
      ]);
      const parsed = JSON.parse(files[0]!.content);
      expect(parsed.mcpServers["test-server"]).toEqual({
        command: "npx",
        args: ["-y", "test-mcp"],
        env: { KEY: "val" },
      });
      expect(parsed.mcpServers.minimal).toEqual({
        command: "node",
        args: [],
      });
    });

    it("omits empty headers for http/sse and includes non-empty headers", async () => {
      const files = await adapter.generate([
        {
          id: "http-no-headers",
          name: "HTTP",
          transport: { type: "http", url: "https://mcp.example.com/mcp" },
        },
        {
          id: "sse-with-headers",
          name: "SSE",
          transport: {
            type: "sse",
            url: "http://localhost:3000",
            headers: { Authorization: "Bearer tok" },
          },
        },
      ]);
      const parsed = JSON.parse(files[0]!.content);
      expect(parsed.mcpServers["http-no-headers"]).toEqual({
        httpUrl: "https://mcp.example.com/mcp",
      });
      expect(parsed.mcpServers["sse-with-headers"]).toEqual({
        url: "http://localhost:3000",
        headers: { Authorization: "Bearer tok" },
      });
    });
  });

  describe("install & uninstall", () => {
    it("merges into existing settings.json and strips only mcpServers on uninstall", async () => {
      await mkdir(join(tempDir, ".gemini"), { recursive: true });
      const settingsPath = join(tempDir, ".gemini", "settings.json");
      await writeFile(
        settingsPath,
        JSON.stringify({
          theme: "GitHub",
          security: { auth: { selectedType: "oauth-personal" } },
          hooks: { BeforeTool: [] },
          mcpServers: { existing: { command: "keep-me" } },
        }),
        "utf-8",
      );

      const files = await adapter.generate([testServer]);
      await adapter.install(files, tempDir);

      const afterInstall = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(afterInstall.theme).toBe("GitHub");
      expect(afterInstall.security).toEqual({ auth: { selectedType: "oauth-personal" } });
      expect(afterInstall.hooks).toEqual({ BeforeTool: [] });
      expect(afterInstall.mcpServers.existing).toEqual({ command: "keep-me" });
      expect(afterInstall.mcpServers["test-server"].command).toBe("npx");

      await adapter.uninstall(tempDir);
      const afterUninstall = JSON.parse(await readFile(settingsPath, "utf-8"));
      expect(afterUninstall.theme).toBe("GitHub");
      expect(afterUninstall.security).toEqual({ auth: { selectedType: "oauth-personal" } });
      expect(afterUninstall.hooks).toEqual({ BeforeTool: [] });
      expect(afterUninstall.mcpServers).toBeUndefined();
    });
  });

  describe("import", () => {
    it("imports stdio, httpUrl, and url servers and guards malformed JSON", async () => {
      await mkdir(join(tempDir, ".gemini"), { recursive: true });
      const settingsPath = join(tempDir, ".gemini", "settings.json");
      await writeFile(
        settingsPath,
        JSON.stringify({
          mcpServers: {
            stdio: { command: "npx", args: ["-y", "test"], env: { A: "1" } },
            http: { httpUrl: "https://mcp.example.com/mcp" },
            sse: { url: "http://localhost:3000", headers: { "X-Api": "1" } },
          },
        }),
        "utf-8",
      );

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(3);
      expect(imported.find((s) => s.id === "stdio")?.transport.type).toBe("stdio");
      expect(imported.find((s) => s.id === "http")?.transport).toEqual({
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: undefined,
      });
      expect(imported.find((s) => s.id === "sse")?.transport).toEqual({
        type: "sse",
        url: "http://localhost:3000",
        headers: { "X-Api": "1" },
      });

      // Malformed JSON should return [] rather than throwing
      await writeFile(settingsPath, "{ invalid json", "utf-8");
      expect(await adapter.import(tempDir)).toEqual([]);
    });
  });
});
