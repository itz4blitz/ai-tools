import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotMCPAdapter, resolveCopilotUserConfigPath } from "./copilot.js";
import type { MCPServerDefinition } from "../types/index.js";

describe("CopilotMCPAdapter", () => {
  let adapter: CopilotMCPAdapter;
  let tempDir: string;

  const stdioServer: MCPServerDefinition = {
    id: "test-server",
    name: "Test Server",
    transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { KEY: "val" } },
  };

  const httpServer: MCPServerDefinition = {
    id: "http-server",
    name: "HTTP Server",
    transport: {
      type: "http",
      url: "https://api.example.com/mcp",
      headers: { Authorization: "Bearer token" },
    },
  };

  const sseServer: MCPServerDefinition = {
    id: "sse-server",
    name: "SSE Server",
    transport: { type: "sse", url: "http://localhost:3000/sse" },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-copilot-mcp-"));
    adapter = new CopilotMCPAdapter();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("metadata & OS-aware userConfigPath", () => {
    it("has expected metadata", () => {
      expect(adapter.id).toBe("copilot");
      expect(adapter.name).toBe("Copilot");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configPath).toBe(".vscode/mcp.json");
      expect(adapter.userConfigPath).toBeTruthy();
    });

    it("resolves OS-specific VS Code user mcp.json paths", () => {
      expect(
        resolveCopilotUserConfigPath(
          "win32",
          { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
          "C:\\Users\\dev",
        ),
      ).toBe(join("C:\\Users\\dev\\AppData\\Roaming", "Code", "User", "mcp.json"));
      expect(resolveCopilotUserConfigPath("darwin", {}, "/Users/dev")).toBe(
        join("/Users/dev", "Library", "Application Support", "Code", "User", "mcp.json"),
      );
      expect(resolveCopilotUserConfigPath("linux", {}, "/home/dev")).toBe(
        join("/home/dev", ".config", "Code", "User", "mcp.json"),
      );
    });
  });

  describe("generate & import", () => {
    it("preserves stdio, http, and sse transports on generate and import", async () => {
      const files = await adapter.generate([stdioServer, httpServer, sseServer]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".vscode/mcp.json");

      const parsed = JSON.parse(files[0]!.content);
      expect(parsed.servers["test-server"].type).toBe("stdio");
      expect(parsed.servers["http-server"].type).toBe("http");
      expect(parsed.servers["sse-server"].type).toBe("sse");

      await adapter.install(files, tempDir);
      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(3);
      expect(imported.find((s) => s.id === "test-server")?.transport.type).toBe("stdio");
      expect(imported.find((s) => s.id === "http-server")?.transport).toEqual({
        type: "http",
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer token" },
      });
      expect(imported.find((s) => s.id === "sse-server")?.transport.type).toBe("sse");
    });

    it("merges into existing .vscode/mcp.json preserving servers and inputs", async () => {
      const vscodeDir = join(tempDir, ".vscode");
      await mkdir(vscodeDir, { recursive: true });
      const mcpPath = join(vscodeDir, "mcp.json");
      await writeFile(
        mcpPath,
        JSON.stringify(
          {
            inputs: [{ id: "api-key", type: "promptString", description: "API Key" }],
            servers: {
              existing: { type: "stdio", command: "node", args: ["existing.js"] },
            },
          },
          null,
          2,
        ),
      );

      const files = await adapter.generate([httpServer]);
      await adapter.install(files, tempDir);

      const merged = JSON.parse(await readFile(mcpPath, "utf-8"));
      expect(merged.inputs).toEqual([
        { id: "api-key", type: "promptString", description: "API Key" },
      ]);
      expect(merged.servers.existing).toEqual({
        type: "stdio",
        command: "node",
        args: ["existing.js"],
      });
      expect(merged.servers["http-server"]).toMatchObject({
        type: "http",
        url: "https://api.example.com/mcp",
      });
    });

    it("imports user config via importUser()", async () => {
      const userMcpPath = join(tempDir, "user-mcp.json");
      await writeFile(
        userMcpPath,
        JSON.stringify({
          servers: {
            remote: { type: "http", url: "https://user.example.com/mcp" },
          },
        }),
      );

      Object.defineProperty(adapter, "userConfigPath", { value: userMcpPath });
      const servers = await adapter.importUser();
      expect(servers).toHaveLength(1);
      expect(servers[0]?.id).toBe("remote");
      expect(servers[0]?.transport.type).toBe("http");
    });
  });

  describe("detect & safe uninstall", () => {
    it("detects via .vscode/mcp.json, code, or copilot", async () => {
      Object.defineProperty(adapter, "userConfigPath", {
        value: join(tempDir, "missing-user-mcp.json"),
      });
      const cmdSpy = vi
        .spyOn(
          adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
          "commandExists",
        )
        .mockResolvedValue(false);

      expect(await adapter.detect(tempDir)).toBe(false);
      expect(cmdSpy).toHaveBeenCalledWith("code");
      expect(cmdSpy).toHaveBeenCalledWith("copilot");

      cmdSpy.mockImplementation(async (cmd) => cmd === "code");
      expect(await adapter.detect(tempDir)).toBe(true);
    });

    it("removes .vscode/mcp.json on uninstall when only servers exist", async () => {
      const files = await adapter.generate([stdioServer]);
      await adapter.install(files, tempDir);
      const mcpPath = join(tempDir, ".vscode/mcp.json");
      expect(existsSync(mcpPath)).toBe(true);

      await adapter.uninstall(tempDir);
      expect(existsSync(mcpPath)).toBe(false);
    });

    it("preserves inputs in .vscode/mcp.json on uninstall", async () => {
      const vscodeDir = join(tempDir, ".vscode");
      await mkdir(vscodeDir, { recursive: true });
      const mcpPath = join(vscodeDir, "mcp.json");
      await writeFile(
        mcpPath,
        JSON.stringify({
          inputs: [{ id: "token", type: "promptString" }],
          servers: { s1: { type: "stdio", command: "node" } },
        }),
      );

      await adapter.uninstall(tempDir);
      expect(existsSync(mcpPath)).toBe(true);
      const remaining = JSON.parse(await readFile(mcpPath, "utf-8"));
      expect(remaining.inputs).toEqual([{ id: "token", type: "promptString" }]);
      expect(remaining.servers).toBeUndefined();
    });
  });
});
