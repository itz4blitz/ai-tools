import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KiroMCPAdapter } from "./kiro.js";
import type { MCPServerDefinition } from "../types/index.js";

describe("KiroMCPAdapter", () => {
  let adapter: KiroMCPAdapter;
  let tempDir: string;

  const stdioServer: MCPServerDefinition = {
    id: "test-server",
    name: "Test Server",
    transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { KEY: "val" } },
  };

  beforeEach(async () => {
    adapter = new KiroMCPAdapter();
    tempDir = await mkdtemp(join(tmpdir(), "kiro-mcp-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct id, name, nativeSupport, and config paths", () => {
      expect(adapter.id).toBe("kiro");
      expect(adapter.name).toBe("Kiro");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configPath).toBe(".kiro/settings/mcp.json");
      expect(adapter.userConfigPath).toMatch(/\.kiro[\\/]+settings[\\/]+mcp\.json$/);
    });
  });

  describe("generate", () => {
    it("generates stdio, sse, and http servers at .kiro/settings/mcp.json", async () => {
      const servers: MCPServerDefinition[] = [
        stdioServer,
        {
          id: "sse-server",
          name: "SSE Server",
          transport: { type: "sse", url: "http://localhost:3000/sse", headers: { X: "1" } },
        },
        {
          id: "http-server",
          name: "HTTP Server",
          transport: { type: "http", url: "https://example.com/mcp" },
          enabled: false,
        },
      ];

      const files = await adapter.generate(servers);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".kiro/settings/mcp.json");
      expect(files[0]!.format).toBe("json");

      const parsed = JSON.parse(files[0]!.content) as {
        mcpServers: Record<string, Record<string, unknown>>;
      };
      expect(parsed.mcpServers["test-server"]).toEqual({
        command: "npx",
        args: ["-y", "test-mcp"],
        env: { KEY: "val" },
      });
      expect(parsed.mcpServers["sse-server"]).toEqual({
        type: "sse",
        url: "http://localhost:3000/sse",
        headers: { X: "1" },
      });
      expect(parsed.mcpServers["http-server"]).toEqual({
        type: "http",
        url: "https://example.com/mcp",
        headers: {},
        disabled: true,
      });
    });

    it("handles empty servers array", async () => {
      const files = await adapter.generate([]);
      const parsed = JSON.parse(files[0]!.content) as { mcpServers: Record<string, unknown> };
      expect(parsed.mcpServers).toEqual({});
    });
  });

  describe("install and import", () => {
    it("merges non-destructively with existing .kiro/settings/mcp.json", async () => {
      const configFile = join(tempDir, ".kiro", "settings", "mcp.json");
      await mkdir(join(tempDir, ".kiro", "settings"), { recursive: true });
      await writeFile(
        configFile,
        JSON.stringify(
          {
            customSetting: true,
            mcpServers: {
              existing: { command: "node", args: ["existing.js"], env: {} },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const files = await adapter.generate([stdioServer]);
      await adapter.install(files, tempDir);

      const raw = JSON.parse(await readFile(configFile, "utf-8")) as {
        customSetting: boolean;
        mcpServers: Record<string, unknown>;
      };
      expect(raw.customSetting).toBe(true);
      expect(raw.mcpServers.existing).toBeDefined();
      expect(raw.mcpServers["test-server"]).toBeDefined();
    });

    it("imports stdio, http, sse, and disabled servers from temp dir", async () => {
      const files = await adapter.generate([
        stdioServer,
        {
          id: "disabled-http",
          name: "Disabled HTTP",
          transport: { type: "http", url: "https://api.example.com/mcp" },
          enabled: false,
        },
        {
          id: "sse-one",
          name: "SSE One",
          transport: { type: "sse", url: "http://localhost:4000/events" },
        },
      ]);
      await adapter.install(files, tempDir);

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(3);

      const stdio = imported.find((s) => s.id === "test-server");
      expect(stdio?.transport).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "test-mcp"],
        env: { KEY: "val" },
      });
      expect(stdio?.enabled).toBeUndefined();

      const http = imported.find((s) => s.id === "disabled-http");
      expect(http?.transport).toEqual({
        type: "http",
        url: "https://api.example.com/mcp",
        headers: {},
      });
      expect(http?.enabled).toBe(false);

      const sse = imported.find((s) => s.id === "sse-one");
      expect(sse?.transport.type).toBe("sse");
    });

    it("returns empty array when config does not exist", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });
  });

  describe("detect", () => {
    it("returns true when .kiro/settings/mcp.json exists", async () => {
      const files = await adapter.generate([stdioServer]);
      await adapter.install(files, tempDir);
      expect(await adapter.detect(tempDir)).toBe(true);
    });

    it("detects kiro-cli when kiro binary is absent", async () => {
      const spy = vi
        .spyOn(
          adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
          "commandExists",
        )
        .mockImplementation(async (cmd) => cmd === "kiro-cli");

      expect(await adapter.detect(tempDir)).toBe(true);
      expect(spy).toHaveBeenCalledWith("kiro");
      expect(spy).toHaveBeenCalledWith("kiro-cli");
    });
  });

  describe("uninstall", () => {
    it("removes .kiro/settings/mcp.json when it only contains mcpServers", async () => {
      const files = await adapter.generate([stdioServer]);
      await adapter.install(files, tempDir);
      const configFile = join(tempDir, ".kiro", "settings", "mcp.json");
      expect(existsSync(configFile)).toBe(true);

      await adapter.uninstall(tempDir);
      expect(existsSync(configFile)).toBe(false);
    });

    it("preserves non-mcpServers keys when uninstalling", async () => {
      const configFile = join(tempDir, ".kiro", "settings", "mcp.json");
      await mkdir(join(tempDir, ".kiro", "settings"), { recursive: true });
      await writeFile(
        configFile,
        JSON.stringify({ theme: "dark", mcpServers: { a: { command: "node" } } }),
        "utf-8",
      );

      await adapter.uninstall(tempDir);
      expect(existsSync(configFile)).toBe(true);
      const remaining = JSON.parse(await readFile(configFile, "utf-8")) as Record<string, unknown>;
      expect(remaining).toEqual({ theme: "dark" });
    });

    it("does nothing when config file does not exist", async () => {
      await expect(adapter.uninstall(tempDir)).resolves.toBeUndefined();
    });
  });
});
