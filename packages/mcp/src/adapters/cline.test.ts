import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClineMCPAdapter, resolveClineMcpSettingsPath } from "./cline.js";
import type { MCPServerDefinition } from "../types/index.js";

describe("ClineMCPAdapter", () => {
  let adapter: ClineMCPAdapter;
  let tempDir: string;
  const origEnv = process.env.CLINE_MCP_SETTINGS_PATH;

  const testServer: MCPServerDefinition = {
    id: "test-server",
    name: "Test Server",
    transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { KEY: "val" } },
  };

  beforeEach(async () => {
    delete process.env.CLINE_MCP_SETTINGS_PATH;
    adapter = new ClineMCPAdapter();
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-cline-mcp-"));
  });

  afterEach(async () => {
    if (origEnv === undefined) {
      delete process.env.CLINE_MCP_SETTINGS_PATH;
    } else {
      process.env.CLINE_MCP_SETTINGS_PATH = origEnv;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct id, name, nativeSupport, and configPath", () => {
      expect(adapter.id).toBe("cline");
      expect(adapter.name).toBe("Cline");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configPath).toBe(".cline/mcp_settings.json");
      expect(adapter.userConfigPath).toBeTruthy();
    });
  });

  describe("resolveClineMcpSettingsPath (OS matrix)", () => {
    it("prefers CLINE_MCP_SETTINGS_PATH env override", () => {
      const resolved = resolveClineMcpSettingsPath({
        platform: "linux",
        home: "/home/dev",
        env: { CLINE_MCP_SETTINGS_PATH: "/custom/cline_mcp_settings.json" },
        exists: () => false,
      });
      expect(resolved).toBe("/custom/cline_mcp_settings.json");
    });

    it("resolves macOS VS Code globalStorage path", () => {
      const resolved = resolveClineMcpSettingsPath({
        platform: "darwin",
        home: "/Users/dev",
        env: {},
        exists: () => false,
      });
      expect(resolved).toBe(
        join(
          "/Users/dev",
          "Library",
          "Application Support",
          "Code",
          "User",
          "globalStorage",
          "saoudrizwan.claude-dev",
          "settings",
          "cline_mcp_settings.json",
        ),
      );
    });

    it("resolves Windows VS Code globalStorage path using APPDATA", () => {
      const resolved = resolveClineMcpSettingsPath({
        platform: "win32",
        home: "C:\\Users\\dev",
        env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
        exists: () => false,
      });
      expect(resolved).toBe(
        join(
          "C:\\Users\\dev\\AppData\\Roaming",
          "Code",
          "User",
          "globalStorage",
          "saoudrizwan.claude-dev",
          "settings",
          "cline_mcp_settings.json",
        ),
      );
    });

    it("resolves Linux VS Code globalStorage path using XDG_CONFIG_HOME", () => {
      const resolved = resolveClineMcpSettingsPath({
        platform: "linux",
        home: "/home/dev",
        env: { XDG_CONFIG_HOME: "/home/dev/.xdg" },
        exists: () => false,
      });
      expect(resolved).toBe(
        join(
          "/home/dev/.xdg",
          "Code",
          "User",
          "globalStorage",
          "saoudrizwan.claude-dev",
          "settings",
          "cline_mcp_settings.json",
        ),
      );
    });

    it("falls back to CLI ~/.cline/data/settings/cline_mcp_settings.json when present", () => {
      const cliPath = join("/home/dev", ".cline", "data", "settings", "cline_mcp_settings.json");
      const resolved = resolveClineMcpSettingsPath({
        platform: "linux",
        home: "/home/dev",
        env: {},
        exists: (p) => p === cliPath,
      });
      expect(resolved).toBe(cliPath);
    });
  });

  describe("generate & import", () => {
    it("encodes stdio, http -> streamableHttp, sse -> sse, and preserves enabled/disabled", async () => {
      const servers: MCPServerDefinition[] = [
        testServer,
        {
          id: "http-server",
          name: "HTTP Server",
          enabled: false,
          transport: {
            type: "http",
            url: "https://mcp.example.com/v1",
            headers: { Authorization: "Bearer tok" },
          },
        },
        {
          id: "sse-server",
          name: "SSE Server",
          enabled: true,
          transport: { type: "sse", url: "http://localhost:3000/sse" },
        },
      ];

      const files = await adapter.generate(servers);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".cline/mcp_settings.json");
      expect(files[0]!.format).toBe("json");

      const parsed = JSON.parse(files[0]!.content) as {
        mcpServers: Record<string, Record<string, unknown>>;
      };
      expect(parsed.mcpServers["test-server"]).toEqual({
        command: "npx",
        args: ["-y", "test-mcp"],
        env: { KEY: "val" },
      });
      expect(parsed.mcpServers["http-server"]).toEqual({
        type: "streamableHttp",
        url: "https://mcp.example.com/v1",
        headers: { Authorization: "Bearer tok" },
        disabled: true,
      });
      expect(parsed.mcpServers["sse-server"]).toEqual({
        type: "sse",
        url: "http://localhost:3000/sse",
        headers: {},
        disabled: false,
      });

      await adapter.install(files, tempDir);
      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(3);

      const httpImported = imported.find((s) => s.id === "http-server")!;
      expect(httpImported.transport.type).toBe("http");
      expect(httpImported.enabled).toBe(false);

      const sseImported = imported.find((s) => s.id === "sse-server")!;
      expect(sseImported.transport.type).toBe("sse");
      expect(sseImported.enabled).toBe(true);
    });

    it("returns empty array when config file does not exist", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });
  });

  describe("install merge & safe uninstall", () => {
    it("merges new servers without wiping existing user servers or top-level keys", async () => {
      const configPath = join(tempDir, ".cline", "mcp_settings.json");
      await mkdir(join(tempDir, ".cline"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify(
          {
            customSetting: true,
            mcpServers: {
              "existing-user-server": { command: "python", args: ["srv.py"], env: {} },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const files = await adapter.generate([testServer]);
      await adapter.install(files, tempDir);

      const merged = JSON.parse(await readFile(configPath, "utf-8")) as {
        customSetting: boolean;
        mcpServers: Record<string, unknown>;
      };
      expect(merged.customSetting).toBe(true);
      expect(merged.mcpServers["existing-user-server"]).toBeDefined();
      expect(merged.mcpServers["test-server"]).toBeDefined();

      // Safe uninstall should keep customSetting and only strip mcpServers
      await adapter.uninstall(tempDir);
      expect(existsSync(configPath)).toBe(true);
      const afterUninstall = JSON.parse(await readFile(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      expect(afterUninstall.customSetting).toBe(true);
      expect(afterUninstall.mcpServers).toBeUndefined();
    });

    it("removes file on uninstall when mcpServers is the only key", async () => {
      const files = await adapter.generate([testServer]);
      await adapter.install(files, tempDir);
      const configPath = join(tempDir, ".cline", "mcp_settings.json");
      expect(existsSync(configPath)).toBe(true);

      await adapter.uninstall(tempDir);
      expect(existsSync(configPath)).toBe(false);
    });
  });

  describe("importUser & detect", () => {
    it("reads user config via CLINE_MCP_SETTINGS_PATH", async () => {
      const userSettings = join(tempDir, "user_cline_mcp_settings.json");
      await writeFile(
        userSettings,
        JSON.stringify({
          mcpServers: {
            remote: { type: "streamableHttp", url: "https://remote.test/mcp", disabled: false },
          },
        }),
        "utf-8",
      );
      process.env.CLINE_MCP_SETTINGS_PATH = userSettings;
      const envAdapter = new ClineMCPAdapter();

      expect(envAdapter.userConfigPath).toBe(userSettings);
      expect(await envAdapter.detect(tempDir)).toBe(true);

      const imported = await envAdapter.importUser();
      expect(imported).toHaveLength(1);
      expect(imported[0]!.id).toBe("remote");
      expect(imported[0]!.transport.type).toBe("http");
      expect(imported[0]!.enabled).toBe(true);
    });
  });
});
