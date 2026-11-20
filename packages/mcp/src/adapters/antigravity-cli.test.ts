import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MCPServerDefinition } from "../types/index.js";

const { mockHome } = vi.hoisted(() => ({ mockHome: { value: "" } }));

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
import { AntigravityCliMCPAdapter } from "./antigravity-cli.js";

describe("AntigravityCliMCPAdapter", () => {
  let adapter: AntigravityCliMCPAdapter;
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
    tmp = await mkdtemp(join(tmpdir(), "agy-mcp-"));
    home = await mkdtemp(join(tmpdir(), "agy-home-"));
    mockHome.value = home;
    adapter = new AntigravityCliMCPAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("uses Antigravity CLI identity and paths", () => {
    expect(adapter.id).toBe("antigravity-cli");
    expect(adapter.name).toBe("Antigravity CLI");
    expect(adapter.command).toBe("agy");
    expect(adapter.configPath).toBe(".agents/plugins/ai-tools/mcp_config.json");
    expect(adapter.userConfigPath).toBe(join(home, ".gemini", "config", "mcp_config.json"));
  });

  it("detects project config, user config, settings.json, and agy command", async () => {
    expect(await adapter.detect(tmp)).toBe(false);

    await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(join(home, ".gemini", "antigravity-cli", "settings.json"), "{}\n", "utf-8");
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(home, ".gemini"), { recursive: true, force: true });
    await mkdir(join(home, ".gemini", "config"), { recursive: true });
    await writeFile(join(home, ".gemini", "config", "mcp_config.json"), "{}\n", "utf-8");
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(home, ".gemini"), { recursive: true, force: true });
    await mkdir(join(tmp, ".agents", "plugins", "ai-tools"), { recursive: true });
    await writeFile(
      join(tmp, ".agents", "plugins", "ai-tools", "mcp_config.json"),
      "{}\n",
      "utf-8",
    );
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(tmp, ".agents"), { recursive: true, force: true });
    vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof execFile);
    expect(await adapter.detect(tmp)).toBe(true);
  });

  it("generates mcp_config.json and plugin.json, merges non-destructively on install, and safely uninstalls", async () => {
    const files = await adapter.generate([stdioServer, httpServer]);
    expect(files.map((f) => f.path)).toEqual([
      ".agents/plugins/ai-tools/mcp_config.json",
      ".agents/plugins/ai-tools/plugin.json",
    ]);

    // Pre-populate an existing mcp_config.json to verify non-destructive merge
    await mkdir(join(tmp, ".agents/plugins/ai-tools"), { recursive: true });
    await writeFile(
      join(tmp, ".agents/plugins/ai-tools/mcp_config.json"),
      JSON.stringify({
        keepTopLevel: true,
        mcpServers: {
          existing: { command: "node", args: ["existing.js"] },
        },
      }),
      "utf-8",
    );

    await adapter.install(files, tmp);

    const written = JSON.parse(
      await readFile(join(tmp, ".agents/plugins/ai-tools/mcp_config.json"), "utf-8"),
    ) as { keepTopLevel: boolean; mcpServers: Record<string, Record<string, unknown>> };
    expect(written.keepTopLevel).toBe(true);
    expect(written.mcpServers.existing).toEqual({ command: "node", args: ["existing.js"] });
    expect(written.mcpServers.filesystem).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { ROOT: "/workspace" },
    });
    expect(written.mcpServers.linear).toEqual({
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer token" },
    });

    const manifest = JSON.parse(
      await readFile(join(tmp, ".agents/plugins/ai-tools/plugin.json"), "utf-8"),
    ) as { name: string };
    expect(manifest).toEqual({ name: "ai-tools" });

    // Other plugin directories must remain untouched on uninstall
    await mkdir(join(tmp, ".agents/plugins/other-plugin"), { recursive: true });
    await writeFile(join(tmp, ".agents/plugins/other-plugin/plugin.json"), '{"name":"other"}\n');

    await adapter.uninstall(tmp);
    expect(existsSync(join(tmp, ".agents/plugins/ai-tools"))).toBe(false);
    expect(existsSync(join(tmp, ".agents/plugins/other-plugin/plugin.json"))).toBe(true);
  });

  it("imports url and legacy serverUrl from project and user configs", async () => {
    await mkdir(join(tmp, ".agents/plugins/ai-tools"), { recursive: true });
    await writeFile(
      join(tmp, ".agents/plugins/ai-tools/mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          local: { command: "node", args: ["srv.js"], env: { A: "1" } },
          modern: { url: "https://example.com/mcp" },
          legacy: { serverUrl: "https://legacy.example.com/mcp" },
        },
      }),
      "utf-8",
    );

    const projectServers = await adapter.import(tmp);
    expect(projectServers).toHaveLength(3);
    expect(projectServers.find((s) => s.id === "local")?.transport).toEqual({
      type: "stdio",
      command: "node",
      args: ["srv.js"],
      env: { A: "1" },
    });
    expect(projectServers.find((s) => s.id === "modern")?.transport).toEqual({
      type: "http",
      url: "https://example.com/mcp",
    });
    expect(projectServers.find((s) => s.id === "legacy")?.transport).toEqual({
      type: "http",
      url: "https://legacy.example.com/mcp",
    });

    await mkdir(join(home, ".gemini/config"), { recursive: true });
    await writeFile(
      join(home, ".gemini/config/mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          userSrv: { serverUrl: "https://user.example.com/mcp", headers: { "X-Key": "val" } },
        },
      }),
      "utf-8",
    );

    const userServers = await adapter.importUser();
    expect(userServers).toEqual([
      {
        id: "userSrv",
        name: "userSrv",
        transport: {
          type: "http",
          url: "https://user.example.com/mcp",
          headers: { "X-Key": "val" },
        },
      },
    ]);
  });
});
