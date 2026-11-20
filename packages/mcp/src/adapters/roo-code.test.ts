import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { RooCodeMCPAdapter, resolveRooCodeUserConfigPath } from "./roo-code.js";
import type { MCPServerDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-mcp-roo-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveRooCodeUserConfigPath", () => {
  it("resolves Windows path using APPDATA", () => {
    const result = resolveRooCodeUserConfigPath(
      "win32",
      { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
      "C:\\Users\\dev",
    );
    expect(result).toBe(
      join(
        "C:\\Users\\dev\\AppData\\Roaming",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "settings",
        "mcp_settings.json",
      ),
    );
  });

  it("falls back to home AppData/Roaming on Windows when APPDATA is unset", () => {
    const result = resolveRooCodeUserConfigPath("win32", {}, "C:\\Users\\dev");
    expect(result).toBe(
      join(
        "C:\\Users\\dev",
        "AppData",
        "Roaming",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "settings",
        "mcp_settings.json",
      ),
    );
  });

  it("resolves macOS path under Library/Application Support", () => {
    const result = resolveRooCodeUserConfigPath("darwin", {}, "/Users/dev");
    expect(result).toBe(
      join(
        "/Users/dev",
        "Library",
        "Application Support",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "settings",
        "mcp_settings.json",
      ),
    );
  });

  it("resolves Linux path under ~/.config by default", () => {
    const result = resolveRooCodeUserConfigPath("linux", {}, "/home/dev");
    expect(result).toBe(
      join(
        "/home/dev",
        ".config",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "settings",
        "mcp_settings.json",
      ),
    );
  });

  it("respects XDG_CONFIG_HOME on Linux", () => {
    const result = resolveRooCodeUserConfigPath(
      "linux",
      { XDG_CONFIG_HOME: "/custom/config" },
      "/home/dev",
    );
    expect(result).toBe(
      join(
        "/custom/config",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "settings",
        "mcp_settings.json",
      ),
    );
  });
});

describe("RooCodeMCPAdapter", () => {
  let adapter: RooCodeMCPAdapter;

  const stdioServer: MCPServerDefinition = {
    id: "test-server",
    name: "Test Server",
    transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { KEY: "val" } },
  };

  const httpServer: MCPServerDefinition = {
    id: "linear",
    name: "Linear",
    transport: {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer token" },
    },
  };

  const sseServer: MCPServerDefinition = {
    id: "sse-server",
    name: "SSE Server",
    transport: { type: "sse", url: "http://localhost:3000/sse" },
  };

  beforeEach(() => {
    adapter = new RooCodeMCPAdapter();
  });

  describe("metadata", () => {
    it("has correct id", () => expect(adapter.id).toBe("roo-code"));
    it("has correct name", () => expect(adapter.name).toBe("Roo Code"));
    it("has native support", () => expect(adapter.nativeSupport).toBe(true));
    it("has correct configPath", () => expect(adapter.configPath).toBe(".roo/mcp.json"));
    it("sets OS-aware userConfigPath", () => {
      expect(adapter.userConfigPath).toBe(resolveRooCodeUserConfigPath());
    });
  });

  describe("generate", () => {
    it("generates stdio, streamable-http, and sse transports", async () => {
      const files = await adapter.generate([stdioServer, httpServer, sseServer]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".roo/mcp.json");
      expect(files[0]!.format).toBe("json");

      const parsed = JSON.parse(files[0]!.content) as {
        mcpServers: Record<string, Record<string, unknown>>;
      };
      expect(parsed.mcpServers["test-server"]).toEqual({
        command: "npx",
        args: ["-y", "test-mcp"],
        env: { KEY: "val" },
      });
      expect(parsed.mcpServers.linear).toEqual({
        type: "streamable-http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer token" },
      });
      expect(parsed.mcpServers["sse-server"]).toEqual({
        type: "sse",
        url: "http://localhost:3000/sse",
        headers: {},
      });
    });

    it("handles empty servers array", async () => {
      const files = await adapter.generate([]);
      const parsed = JSON.parse(files[0]!.content) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(parsed.mcpServers)).toHaveLength(0);
    });

    it("defaults optional stdio args and env", async () => {
      const server: MCPServerDefinition = {
        id: "minimal",
        name: "Minimal",
        transport: { type: "stdio", command: "node" },
      };
      const files = await adapter.generate([server]);
      const parsed = JSON.parse(files[0]!.content) as {
        mcpServers: Record<string, Record<string, unknown>>;
      };
      expect(parsed.mcpServers.minimal).toEqual({
        command: "node",
        args: [],
        env: {},
      });
    });
  });

  describe("install & merge", () => {
    it("merges existing servers and preserves Roo fields on updated servers", async () => {
      await withTempDir(async (dir) => {
        const mcpPath = join(dir, ".roo/mcp.json");
        await mkdir(join(dir, ".roo"), { recursive: true });
        await writeFile(
          mcpPath,
          JSON.stringify(
            {
              extraSetting: true,
              mcpServers: {
                keep: {
                  command: "keep-mcp",
                  args: [],
                  alwaysAllow: ["read_file"],
                },
                "test-server": {
                  command: "old-cmd",
                  args: [],
                  alwaysAllow: ["search"],
                  disabled: true,
                  timeout: 120,
                },
              },
            },
            null,
            2,
          ),
          "utf-8",
        );

        await adapter.install(await adapter.generate([stdioServer, httpServer]), dir);

        const written = JSON.parse(await readFile(mcpPath, "utf-8")) as {
          extraSetting: boolean;
          mcpServers: Record<string, Record<string, unknown>>;
        };
        expect(written.extraSetting).toBe(true);
        expect(written.mcpServers.keep).toEqual({
          command: "keep-mcp",
          args: [],
          alwaysAllow: ["read_file"],
        });
        expect(written.mcpServers["test-server"]).toEqual({
          command: "npx",
          args: ["-y", "test-mcp"],
          env: { KEY: "val" },
          alwaysAllow: ["search"],
          disabled: true,
          timeout: 120,
        });
        expect(written.mcpServers.linear).toEqual({
          type: "streamable-http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer token" },
        });
      });
    });

    it("merges into an absolute userConfigPath without clobbering existing servers", async () => {
      await withTempDir(async (dir) => {
        const userConfigPath = join(dir, "settings", "mcp_settings.json");
        await mkdir(join(dir, "settings"), { recursive: true });
        await writeFile(
          userConfigPath,
          JSON.stringify({
            mcpServers: { existing: { command: "existing-bin", timeout: 60 } },
          }),
          "utf-8",
        );

        const customAdapter = new RooCodeMCPAdapter(userConfigPath);
        const files = await customAdapter.generate([httpServer]);
        files[0]!.path = userConfigPath;
        await customAdapter.install(files, dir);

        const imported = await customAdapter.importUser();
        expect(imported.map((s) => s.id).toSorted()).toEqual(["existing", "linear"]);
        expect(imported.find((s) => s.id === "linear")?.transport).toEqual(httpServer.transport);
      });
    });
  });

  describe("import & importUser", () => {
    it("returns empty array when project config is missing", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(dir)).toEqual([]);
      });
    });

    it("round-trips stdio, streamable-http, and sse transports", async () => {
      await withTempDir(async (dir) => {
        await adapter.install(await adapter.generate([stdioServer, httpServer, sseServer]), dir);

        const imported = await adapter.import(dir);
        expect(imported).toHaveLength(3);
        expect(imported.find((s) => s.id === "test-server")?.transport).toEqual(
          stdioServer.transport,
        );
        expect(imported.find((s) => s.id === "linear")?.transport).toEqual(httpServer.transport);
        expect(imported.find((s) => s.id === "sse-server")?.transport).toMatchObject({
          type: "sse",
          url: "http://localhost:3000/sse",
        });
      });
    });

    it("imports legacy http and typeless url configs", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".roo"), { recursive: true });
        await writeFile(
          join(dir, ".roo/mcp.json"),
          JSON.stringify({
            mcpServers: {
              legacyHttp: { type: "http", url: "https://example.com/mcp" },
              typelessUrl: { url: "https://example.com/sse" },
            },
          }),
          "utf-8",
        );

        const imported = await adapter.import(dir);
        expect(imported.find((s) => s.id === "legacyHttp")?.transport.type).toBe("http");
        expect(imported.find((s) => s.id === "typelessUrl")?.transport.type).toBe("sse");
      });
    });

    it("imports user-global servers via importUser()", async () => {
      await withTempDir(async (dir) => {
        const userPath = join(dir, "mcp_settings.json");
        await writeFile(
          userPath,
          JSON.stringify({
            mcpServers: {
              globalHttp: {
                type: "streamable-http",
                url: "https://global.example.com/mcp",
                alwaysAllow: ["ping"],
              },
            },
          }),
          "utf-8",
        );

        const customAdapter = new RooCodeMCPAdapter(userPath);
        const result = await customAdapter.importUser();
        expect(result).toEqual([
          {
            id: "globalHttp",
            name: "globalHttp",
            transport: {
              type: "http",
              url: "https://global.example.com/mcp",
            },
          },
        ]);
      });
    });
  });

  describe("detect", () => {
    it("detects project .roo/mcp.json, .roo dir, or userConfigPath", async () => {
      await withTempDir(async (dir) => {
        const missingUserPath = join(dir, "missing-user-mcp.json");
        const isolated = new RooCodeMCPAdapter(missingUserPath);
        expect(await isolated.detect(dir)).toBe(false);

        await mkdir(join(dir, ".roo"), { recursive: true });
        expect(await isolated.detect(dir)).toBe(true);

        const projectOnly = join(dir, "other-project");
        await mkdir(projectOnly, { recursive: true });
        expect(await isolated.detect(projectOnly)).toBe(false);

        await writeFile(missingUserPath, "{}\n", "utf-8");
        expect(await isolated.detect(projectOnly)).toBe(true);
      });
    });
  });

  describe("uninstall", () => {
    it("removes project .roo/mcp.json without touching other files or userConfigPath", async () => {
      await withTempDir(async (dir) => {
        const userPath = join(dir, "user-mcp.json");
        await writeFile(userPath, '{"mcpServers":{}}\n', "utf-8");
        const isolated = new RooCodeMCPAdapter(userPath);

        await isolated.install(await isolated.generate([stdioServer]), dir);
        await writeFile(join(dir, ".roo/other.txt"), "keep", "utf-8");

        await isolated.uninstall(dir);

        expect(existsSync(join(dir, ".roo/mcp.json"))).toBe(false);
        expect(existsSync(join(dir, ".roo/other.txt"))).toBe(true);
        expect(existsSync(userPath)).toBe(true);
      });
    });
  });
});
