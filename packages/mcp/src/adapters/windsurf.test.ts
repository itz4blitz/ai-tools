import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MCPServerDefinition } from "../types/index.js";

const { mockHome } = vi.hoisted(() => ({ mockHome: { value: "" } }));

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHome.value || actual.homedir(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (error: Error | null) => void) => {
    cb(new Error("not found"));
  }),
}));

import { execFile } from "node:child_process";
import { WindsurfMCPAdapter } from "./windsurf.js";

describe("WindsurfMCPAdapter", () => {
  let adapter: WindsurfMCPAdapter;
  let home: string;
  let projectDir: string;

  const stdioServer: MCPServerDefinition = {
    id: "test-server",
    name: "Test Server",
    transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { KEY: "val" } },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    home = await mkdtemp(join(tmpdir(), "windsurf-mcp-home-"));
    projectDir = await mkdtemp(join(tmpdir(), "windsurf-mcp-proj-"));
    mockHome.value = home;
    adapter = new WindsurfMCPAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(home, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("exposes Windsurf user-global metadata", () => {
      expect(adapter.id).toBe("windsurf");
      expect(adapter.name).toBe("Windsurf");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.scope).toBe("user-only");
      expect(adapter.configPath).toBe(".codeium/windsurf/mcp_config.json");
      expect(adapter.userConfigPath).toBe(join(home, ".codeium", "windsurf", "mcp_config.json"));
      expect(adapter.command).toBe("windsurf");
    });
  });

  describe("generate", () => {
    it("generates stdio and remote servers using serverUrl", async () => {
      const httpServer: MCPServerDefinition = {
        id: "remote-http",
        name: "Remote HTTP",
        transport: {
          type: "http",
          url: "https://mcp.example.com/http",
          headers: { Authorization: "Bearer token" },
        },
      };
      const sseServer: MCPServerDefinition = {
        id: "remote-sse",
        name: "Remote SSE",
        transport: { type: "sse", url: "https://mcp.example.com/sse" },
      };

      const files = await adapter.generate([stdioServer, httpServer, sseServer]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".codeium/windsurf/mcp_config.json");
      expect(files[0]?.format).toBe("json");

      const parsed = JSON.parse(files[0]!.content) as { mcpServers: Record<string, unknown> };
      expect(parsed.mcpServers["test-server"]).toEqual({
        command: "npx",
        args: ["-y", "test-mcp"],
        env: { KEY: "val" },
      });
      expect(parsed.mcpServers["remote-http"]).toEqual({
        type: "http",
        serverUrl: "https://mcp.example.com/http",
        headers: { Authorization: "Bearer token" },
      });
      expect(parsed.mcpServers["remote-sse"]).toEqual({
        type: "sse",
        serverUrl: "https://mcp.example.com/sse",
        headers: {},
      });
    });

    it("handles empty servers array", async () => {
      const files = await adapter.generate([]);
      const parsed = JSON.parse(files[0]!.content) as { mcpServers: Record<string, unknown> };
      expect(parsed.mcpServers).toEqual({});
    });
  });

  describe("install and merge", () => {
    it("merges into existing user mcp_config.json without overwriting unrelated keys or servers", async () => {
      await mkdir(join(home, ".codeium", "windsurf"), { recursive: true });
      await writeFile(
        adapter.userConfigPath,
        `${JSON.stringify({
          theme: "dark",
          mcpServers: {
            existing: { command: "uvx", args: ["existing-mcp"] },
          },
        })}\n`,
        "utf-8",
      );

      const files = await adapter.generate([stdioServer]);
      await adapter.install(files);

      const merged = JSON.parse(await readFile(adapter.userConfigPath, "utf-8")) as {
        theme: string;
        mcpServers: Record<string, unknown>;
      };
      expect(merged.theme).toBe("dark");
      expect(merged.mcpServers.existing).toEqual({ command: "uvx", args: ["existing-mcp"] });
      expect(merged.mcpServers["test-server"]).toEqual({
        command: "npx",
        args: ["-y", "test-mcp"],
        env: { KEY: "val" },
      });
    });
  });

  describe("import and importUser", () => {
    it("returns empty array when config file does not exist", async () => {
      expect(await adapter.import(projectDir)).toEqual([]);
      expect(await adapter.importUser()).toEqual([]);
    });

    it("imports stdio, serverUrl, and legacy url entries while preserving http vs sse", async () => {
      await mkdir(join(home, ".codeium", "windsurf"), { recursive: true });
      await writeFile(
        adapter.userConfigPath,
        JSON.stringify({
          mcpServers: {
            local: { command: "node", args: ["server.js"], env: { NODE_ENV: "test" } },
            httpServer: {
              type: "http",
              serverUrl: "https://api.example.com/mcp",
              headers: { "X-Key": "secret" },
            },
            sseServer: {
              serverUrl: "https://sse.example.com/events",
            },
            legacyUrl: {
              type: "http",
              url: "https://legacy.example.com/mcp",
            },
          },
        }),
        "utf-8",
      );

      const imported = await adapter.importUser();
      expect(imported).toEqual([
        {
          id: "local",
          name: "local",
          transport: {
            type: "stdio",
            command: "node",
            args: ["server.js"],
            env: { NODE_ENV: "test" },
          },
        },
        {
          id: "httpServer",
          name: "httpServer",
          transport: {
            type: "http",
            url: "https://api.example.com/mcp",
            headers: { "X-Key": "secret" },
          },
        },
        {
          id: "sseServer",
          name: "sseServer",
          transport: {
            type: "sse",
            url: "https://sse.example.com/events",
          },
        },
        {
          id: "legacyUrl",
          name: "legacyUrl",
          transport: {
            type: "http",
            url: "https://legacy.example.com/mcp",
          },
        },
      ]);
    });
  });

  describe("detect", () => {
    it("returns false when no Windsurf dir, config, or binary exists", async () => {
      expect(await adapter.detect(projectDir)).toBe(false);
    });

    it("detects ~/.codeium/windsurf directory", async () => {
      await mkdir(join(home, ".codeium", "windsurf"), { recursive: true });
      expect(await adapter.detect(projectDir)).toBe(true);
    });

    it("detects the windsurf binary on PATH", async () => {
      vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
        (cb as (error: Error | null) => void)(null);
      }) as typeof execFile);
      expect(await adapter.detect(projectDir)).toBe(true);
    });
  });

  describe("uninstall", () => {
    it("removes only managed servers when managedIds are provided and preserves sibling keys", async () => {
      await mkdir(join(home, ".codeium", "windsurf"), { recursive: true });
      await writeFile(
        adapter.userConfigPath,
        JSON.stringify({
          keepSetting: true,
          mcpServers: {
            "test-server": { command: "npx" },
            "user-server": { command: "uvx" },
          },
        }),
        "utf-8",
      );

      await adapter.uninstall(undefined, ["test-server"]);

      expect(existsSync(adapter.userConfigPath)).toBe(true);
      const after = JSON.parse(await readFile(adapter.userConfigPath, "utf-8")) as {
        keepSetting: boolean;
        mcpServers: Record<string, unknown>;
      };
      expect(after.keepSetting).toBe(true);
      expect(after.mcpServers["test-server"]).toBeUndefined();
      expect(after.mcpServers["user-server"]).toEqual({ command: "uvx" });
    });

    it("clears mcpServers without deleting user mcp_config.json or other keys", async () => {
      await mkdir(join(home, ".codeium", "windsurf"), { recursive: true });
      await writeFile(
        adapter.userConfigPath,
        JSON.stringify({
          keepSetting: true,
          mcpServers: { "test-server": { command: "npx" } },
        }),
        "utf-8",
      );

      await adapter.uninstall();

      expect(existsSync(adapter.userConfigPath)).toBe(true);
      const after = JSON.parse(await readFile(adapter.userConfigPath, "utf-8")) as {
        keepSetting: boolean;
        mcpServers: Record<string, unknown>;
      };
      expect(after).toEqual({ keepSetting: true, mcpServers: {} });
    });
  });
});
