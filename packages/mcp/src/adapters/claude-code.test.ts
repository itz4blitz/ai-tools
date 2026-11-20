import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeMCPAdapter } from "./claude-code.js";
import type { MCPServerDefinition } from "../types/index.js";

const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-mcp-claude-"));
  temps.push(dir);
  return dir;
}

describe("ClaudeCodeMCPAdapter", () => {
  let adapter: ClaudeCodeMCPAdapter;

  const testServer: MCPServerDefinition = {
    id: "test-server",
    name: "Test Server",
    transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { KEY: "val" } },
  };

  const httpServer: MCPServerDefinition = {
    id: "linear",
    name: "Linear",
    transport: { type: "http", url: "https://mcp.linear.app/mcp" },
  };

  beforeEach(() => {
    adapter = new ClaudeCodeMCPAdapter();
  });

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe("metadata", () => {
    it("uses join(homedir(), '.claude.json') for userConfigPath", () => {
      expect(adapter.id).toBe("claude-code");
      expect(adapter.name).toBe("Claude Code");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configPath).toBe(".mcp.json");
      expect(adapter.userConfigPath).toBe(join(homedir(), ".claude.json"));
    });
  });

  describe("roundtrip, projects[cwd].mcpServers, and safe uninstall", () => {
    it("installs, merges, and roundtrips .mcp.json servers", async () => {
      const dir = await tempDir();
      const files = await adapter.generate([testServer, httpServer]);
      await adapter.install(files, dir);

      const imported = await adapter.import(dir);
      expect(imported.find((s) => s.id === "test-server")?.transport).toEqual(testServer.transport);
      expect(imported.find((s) => s.id === "linear")?.transport).toMatchObject({
        type: "http",
        url: "https://mcp.linear.app/mcp",
      });
    });

    it("reads projects[cwd].mcpServers from ~/.claude.json during import()", async () => {
      const dir = await tempDir();
      const fakeUserConfig = join(dir, ".claude.json");
      await writeFile(
        fakeUserConfig,
        JSON.stringify(
          {
            theme: "dark",
            mcpServers: {
              userGlobal: { command: "global-mcp", args: [] },
            },
            projects: {
              [dir]: {
                mcpServers: {
                  localOnly: { command: "local-mcp", args: ["--dev"] },
                },
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      Object.defineProperty(adapter, "userConfigPath", { value: fakeUserConfig });

      const userServers = await adapter.importUser();
      expect(userServers.map((s) => s.id)).toEqual(["userGlobal"]);

      const projectServers = await adapter.import(dir);
      expect(projectServers.map((s) => s.id)).toEqual(["localOnly"]);
    });

    it("uninstall removes only managed MCP entries and preserves unmanaged servers", async () => {
      const dir = await tempDir();
      const mcpPath = join(dir, ".mcp.json");
      await writeFile(
        mcpPath,
        JSON.stringify(
          {
            mcpServers: {
              unmanaged: { command: "keep-me", args: [] },
            },
          },
          null,
          2,
        ) + "\n",
        "utf-8",
      );

      await adapter.install(await adapter.generate([testServer]), dir);
      const afterInstall = JSON.parse(await readFile(mcpPath, "utf-8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(afterInstall.mcpServers).toSorted()).toEqual(["test-server", "unmanaged"]);

      await adapter.uninstall(dir);
      expect(existsSync(mcpPath)).toBe(true);
      const afterUninstall = JSON.parse(await readFile(mcpPath, "utf-8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(afterUninstall.mcpServers)).toEqual(["unmanaged"]);
    });

    it("uninstall removes .mcp.json when only managed entries existed", async () => {
      const dir = await tempDir();
      const mcpPath = join(dir, ".mcp.json");
      await adapter.install(await adapter.generate([testServer]), dir);
      expect(existsSync(mcpPath)).toBe(true);

      await adapter.uninstall(dir);
      expect(existsSync(mcpPath)).toBe(false);
    });

    it("uninstall with explicit managedIds removes only specified IDs", async () => {
      const dir = await tempDir();
      const mcpPath = join(dir, ".mcp.json");
      await writeFile(
        mcpPath,
        JSON.stringify({
          mcpServers: {
            managedA: { command: "a" },
            unmanagedB: { command: "b" },
          },
        }),
        "utf-8",
      );

      await adapter.uninstall(dir, ["managedA"]);
      const parsed = JSON.parse(await readFile(mcpPath, "utf-8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(parsed.mcpServers)).toEqual(["unmanagedB"]);
    });
  });
});
