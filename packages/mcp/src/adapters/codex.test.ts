import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { CodexMCPAdapter } from "./codex.js";
import type { MCPServerDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-mcp-codex-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("CodexMCPAdapter", () => {
  let adapter: CodexMCPAdapter;
  let originalCodexHome: string | undefined;

  const testServer: MCPServerDefinition = {
    id: "test-server",
    name: "Test Server",
    transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { KEY: "val" } },
  };

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    vi.clearAllMocks();
    adapter = new CodexMCPAdapter();
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  });

  describe("metadata", () => {
    it("has correct id, name, nativeSupport, and configPath", () => {
      expect(adapter.id).toBe("codex");
      expect(adapter.name).toBe("Codex");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configPath).toBe(".codex/config.toml");
    });

    it("resolves userConfigPath from CODEX_HOME or falls back to ~/.codex/config.toml", () => {
      delete process.env.CODEX_HOME;
      expect(new CodexMCPAdapter().userConfigPath).toBe(join(homedir(), ".codex", "config.toml"));

      process.env.CODEX_HOME = join(tmpdir(), "custom-codex-home");
      expect(new CodexMCPAdapter().userConfigPath).toBe(
        join(tmpdir(), "custom-codex-home", "config.toml"),
      );
    });
  });

  describe("generate", () => {
    it("generates native Codex TOML for stdio and http servers", async () => {
      const httpServer: MCPServerDefinition = {
        id: "figma",
        name: "figma",
        transport: {
          type: "http",
          url: "https://mcp.figma.com/mcp",
          headers: { "X-Figma-Region": "us-east-1" },
        },
      };
      const files = await adapter.generate([testServer, httpServer]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".codex/config.toml");
      expect(files[0]!.format).toBe("toml");
      expect(files[0]!.content).toContain("[mcp_servers.test-server]");
      expect(files[0]!.content).toContain('command = "npx"');
      expect(files[0]!.content).toContain("[mcp_servers.figma.http_headers]");
      expect(files[0]!.content).toContain('X-Figma-Region = "us-east-1"');
    });

    it("handles empty servers array", async () => {
      const files = await adapter.generate([]);
      expect(files[0]!.content).toBe("");
    });
  });

  describe("install, import, and non-destructive uninstall", () => {
    it("merges MCP tables on install and preserves non-MCP tables on uninstall", async () => {
      await withTempDir(async (dir) => {
        const configPath = join(dir, ".codex", "config.toml");
        await mkdir(join(dir, ".codex"), { recursive: true });
        await writeFile(
          configPath,
          'model = "o3"\n\n[profiles.dev]\napproval_policy = "on-request"\n',
          "utf-8",
        );

        const files = await adapter.generate([testServer]);
        await adapter.install(files, dir);

        const installed = await readFile(configPath, "utf-8");
        expect(installed).toContain('model = "o3"');
        expect(installed).toContain("[profiles.dev]");
        expect(installed).toContain("[mcp_servers.test-server]");

        const imported = await adapter.import(dir);
        expect(imported).toHaveLength(1);
        expect(imported[0]?.id).toBe("test-server");
        expect(imported[0]?.transport).toEqual({
          type: "stdio",
          command: "npx",
          args: ["-y", "test-mcp"],
          env: { KEY: "val" },
        });

        // Non-destructive uninstall must preserve model and [profiles.dev]
        await adapter.uninstall(dir);
        expect(existsSync(configPath)).toBe(true);

        const afterUninstall = await readFile(configPath, "utf-8");
        expect(afterUninstall).toContain('model = "o3"');
        expect(afterUninstall).toContain("[profiles.dev]");
        expect(afterUninstall).toContain('approval_policy = "on-request"');
        expect(afterUninstall).not.toContain("[mcp_servers.test-server]");
      });
    });

    it("deletes .codex/config.toml on uninstall when only MCP tables existed", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testServer]);
        await adapter.install(files, dir);

        const configPath = join(dir, ".codex", "config.toml");
        expect(existsSync(configPath)).toBe(true);

        await adapter.uninstall(dir);
        expect(existsSync(configPath)).toBe(false);
      });
    });

    it("imports user-level servers from $CODEX_HOME/config.toml", async () => {
      await withTempDir(async (dir) => {
        process.env.CODEX_HOME = dir;
        await writeFile(
          join(dir, "config.toml"),
          '[mcp_servers.docs]\nurl = "https://docs.example.com/mcp"\n',
          "utf-8",
        );

        const userAdapter = new CodexMCPAdapter();
        const servers = await userAdapter.importUser();
        expect(servers).toHaveLength(1);
        expect(servers[0]?.id).toBe("docs");
        expect(servers[0]?.transport.type).toBe("http");
      });
    });
  });
});
