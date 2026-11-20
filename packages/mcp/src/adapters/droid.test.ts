import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

import { DroidMCPAdapter } from "./droid.js";

describe("DroidMCPAdapter", () => {
  let adapter: DroidMCPAdapter;
  let tmp: string;
  let home: string;

  const stdioServer: MCPServerDefinition = {
    id: "test-server",
    name: "Test Server",
    transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { KEY: "val" } },
  };

  const httpServer: MCPServerDefinition = {
    id: "linear",
    name: "Linear",
    transport: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Auth: "Bearer x" } },
  };

  const sseServer: MCPServerDefinition = {
    id: "sse-server",
    name: "SSE Server",
    transport: { type: "sse", url: "http://localhost:3000/sse" },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "ai-tools-droid-mcp-"));
    home = await mkdtemp(join(tmpdir(), "ai-tools-droid-mcp-home-"));
    mockHome.value = home;
    adapter = new DroidMCPAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has standardized Factory Droid metadata and userConfigPath", () => {
      expect(adapter.id).toBe("droid");
      expect(adapter.name).toBe("Factory Droid");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configPath).toBe(".factory/mcp.json");
      expect(adapter.userConfigPath).toBe(join(home, ".factory", "mcp.json"));
      expect(adapter.command).toBe("droid");
    });
  });

  describe("generate & import", () => {
    it("generates and round-trips stdio, http, and sse servers preserving transport types", async () => {
      const files = await adapter.generate([stdioServer, httpServer, sseServer]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".factory/mcp.json");
      expect(files[0]!.format).toBe("json");

      await adapter.install(files, tmp);
      const imported = await adapter.import(tmp);
      expect(imported).toHaveLength(3);
      expect(imported.find((s) => s.id === "test-server")?.transport.type).toBe("stdio");
      expect(imported.find((s) => s.id === "linear")?.transport.type).toBe("http");
      expect(imported.find((s) => s.id === "sse-server")?.transport.type).toBe("sse");
    });

    it("imports user MCP config from ~/.factory/mcp.json", async () => {
      await mkdir(join(home, ".factory"), { recursive: true });
      await writeFile(
        join(home, ".factory", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            docs: { type: "http", url: "https://docs.factory.ai/mcp" },
          },
        }),
        "utf-8",
      );

      const imported = await adapter.importUser();
      expect(imported).toHaveLength(1);
      expect(imported[0]!.id).toBe("docs");
      expect(imported[0]!.transport.type).toBe("http");
    });

    it("returns empty array when config is missing or invalid JSON", async () => {
      expect(await adapter.import(tmp)).toEqual([]);
      await mkdir(join(tmp, ".factory"), { recursive: true });
      await writeFile(join(tmp, ".factory", "mcp.json"), "{broken", "utf-8");
      expect(await adapter.import(tmp)).toEqual([]);
    });
  });

  describe("install merge & safe uninstall", () => {
    it("merges into existing .factory/mcp.json without clobbering existing servers or other keys", async () => {
      await mkdir(join(tmp, ".factory"), { recursive: true });
      await writeFile(
        join(tmp, ".factory", "mcp.json"),
        JSON.stringify({
          customFlag: true,
          mcpServers: {
            existing: { command: "node", args: ["server.js"] },
          },
        }),
        "utf-8",
      );

      await adapter.install(await adapter.generate([httpServer]), tmp);

      const written = JSON.parse(await readFile(join(tmp, ".factory", "mcp.json"), "utf-8")) as {
        customFlag: boolean;
        mcpServers: Record<string, { command?: string; type?: string; url?: string }>;
      };
      expect(written.customFlag).toBe(true);
      expect(written.mcpServers.existing?.command).toBe("node");
      expect(written.mcpServers.linear?.type).toBe("http");
    });

    it("safe uninstall removes only specified serverIds while preserving other servers", async () => {
      await adapter.install(await adapter.generate([stdioServer, httpServer]), tmp);
      await adapter.uninstall(tmp, ["linear"]);

      const remaining = JSON.parse(await readFile(join(tmp, ".factory", "mcp.json"), "utf-8")) as {
        mcpServers: Record<string, unknown>;
      };
      expect(remaining.mcpServers["test-server"]).toBeDefined();
      expect(remaining.mcpServers.linear).toBeUndefined();
    });

    it("safe uninstall preserves unrelated top-level keys when removing mcpServers", async () => {
      await mkdir(join(tmp, ".factory"), { recursive: true });
      await writeFile(
        join(tmp, ".factory", "mcp.json"),
        JSON.stringify({
          keepMe: 42,
          mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
        }),
        "utf-8",
      );

      await adapter.uninstall(tmp);
      expect(existsSync(join(tmp, ".factory", "mcp.json"))).toBe(true);
      const written = JSON.parse(
        await readFile(join(tmp, ".factory", "mcp.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(written).toEqual({ keepMe: 42 });
    });

    it("removes .factory/mcp.json when it only contains mcpServers", async () => {
      await adapter.install(await adapter.generate([stdioServer]), tmp);
      await adapter.uninstall(tmp);
      expect(existsSync(join(tmp, ".factory", "mcp.json"))).toBe(false);
    });

    it("does not crash or delete malformed .factory/mcp.json on uninstall", async () => {
      await mkdir(join(tmp, ".factory"), { recursive: true });
      await writeFile(join(tmp, ".factory", "mcp.json"), "{invalid", "utf-8");
      await adapter.uninstall(tmp);
      expect(existsSync(join(tmp, ".factory", "mcp.json"))).toBe(true);
    });
  });
});
