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

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (error: Error | null) => void) => {
    cb(new Error("not found"));
  }),
}));

import { execFile } from "node:child_process";
import { ContinueMCPAdapter } from "./continue.js";

describe("ContinueMCPAdapter", () => {
  let adapter: ContinueMCPAdapter;
  let tmp: string;
  let home: string;

  const stdioServer: MCPServerDefinition = {
    id: "filesystem",
    name: "filesystem",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { ROOT: "/workspace" },
    },
  };

  const httpServer: MCPServerDefinition = {
    id: "linear",
    name: "linear",
    transport: {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer token" },
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "continue-mcp-"));
    home = await mkdtemp(join(tmpdir(), "continue-mcp-home-"));
    mockHome.value = home;
    adapter = new ContinueMCPAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("exposes Continue MCP paths and cn command", () => {
      expect(adapter.id).toBe("continue");
      expect(adapter.name).toBe("Continue");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configPath).toBe(".continue/mcpServers/mcp.json");
      expect(adapter.userConfigPath).toBe(join(home, ".continue", "mcpServers", "mcp.json"));
      expect(adapter.command).toBe("cn");
    });
  });

  describe("generate, install, merge & import", () => {
    it("round-trips stdio and http servers in .continue/mcpServers/mcp.json", async () => {
      const files = await adapter.generate([stdioServer, httpServer]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".continue/mcpServers/mcp.json");
      expect(files[0]?.format).toBe("json");

      await adapter.install(files, tmp);
      const imported = await adapter.import(tmp);
      expect(imported).toEqual([stdioServer, httpServer]);
    });

    it("merges into an existing mcp.json without clobbering existing servers or sibling keys", async () => {
      const mcpPath = join(tmp, ".continue/mcpServers/mcp.json");
      await mkdir(join(tmp, ".continue/mcpServers"), { recursive: true });
      await writeFile(
        mcpPath,
        `${JSON.stringify({
          customKey: "keep-me",
          mcpServers: {
            existing: { command: "node", args: ["existing.js"], env: {} },
          },
        })}\n`,
        "utf-8",
      );

      await adapter.install(await adapter.generate([stdioServer]), tmp);
      const parsed = JSON.parse(await readFile(mcpPath, "utf-8")) as {
        customKey: string;
        mcpServers: Record<string, unknown>;
      };
      expect(parsed.customKey).toBe("keep-me");
      expect(Object.keys(parsed.mcpServers).toSorted()).toEqual(["existing", "filesystem"]);
    });

    it("imports user-level ~/.continue/mcpServers/mcp.json", async () => {
      await mkdir(join(home, ".continue/mcpServers"), { recursive: true });
      await writeFile(
        join(home, ".continue/mcpServers/mcp.json"),
        JSON.stringify({
          mcpServers: {
            userSrv: { type: "sse", url: "http://localhost:3000/sse" },
          },
        }),
        "utf-8",
      );

      const imported = await adapter.importUser();
      expect(imported).toEqual([
        {
          id: "userSrv",
          name: "userSrv",
          transport: { type: "sse", url: "http://localhost:3000/sse" },
        },
      ]);
    });

    it("returns empty array for missing or invalid JSON", async () => {
      expect(await adapter.import(tmp)).toEqual([]);
      await mkdir(join(tmp, ".continue/mcpServers"), { recursive: true });
      await writeFile(join(tmp, ".continue/mcpServers/mcp.json"), "{invalid", "utf-8");
      expect(await adapter.import(tmp)).toEqual([]);
    });
  });

  describe("detect", () => {
    it("detects .continue/mcpServers, .continue/config.yaml, or cn binary", async () => {
      expect(await adapter.detect(tmp)).toBe(false);

      await mkdir(join(tmp, ".continue/mcpServers"), { recursive: true });
      expect(await adapter.detect(tmp)).toBe(true);
      await rm(join(tmp, ".continue"), { recursive: true, force: true });

      await mkdir(join(tmp, ".continue"), { recursive: true });
      await writeFile(join(tmp, ".continue/config.yaml"), "name: test\n", "utf-8");
      expect(await adapter.detect(tmp)).toBe(true);
      await rm(join(tmp, ".continue"), { recursive: true, force: true });

      vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
        (cb as (error: Error | null) => void)(null);
      }) as typeof execFile);
      expect(await adapter.detect(tmp)).toBe(true);
    });
  });

  describe("uninstall", () => {
    it("removes mcp.json when mcpServers is the only key", async () => {
      await adapter.install(await adapter.generate([stdioServer]), tmp);
      const mcpPath = join(tmp, ".continue/mcpServers/mcp.json");
      expect(existsSync(mcpPath)).toBe(true);

      await adapter.uninstall(tmp);
      expect(existsSync(mcpPath)).toBe(false);
    });

    it("preserves sibling keys when uninstalling mcpServers", async () => {
      const mcpPath = join(tmp, ".continue/mcpServers/mcp.json");
      await mkdir(join(tmp, ".continue/mcpServers"), { recursive: true });
      await writeFile(
        mcpPath,
        JSON.stringify({
          keep: true,
          mcpServers: { filesystem: { command: "npx", args: [], env: {} } },
        }),
        "utf-8",
      );

      await adapter.uninstall(tmp);
      expect(existsSync(mcpPath)).toBe(true);
      expect(JSON.parse(await readFile(mcpPath, "utf-8"))).toEqual({ keep: true });
    });

    it("is a no-op when config file does not exist", async () => {
      await expect(adapter.uninstall(tmp)).resolves.toBeUndefined();
    });
  });
});
