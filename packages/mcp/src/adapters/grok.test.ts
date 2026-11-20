import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "node:os";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { GrokMCPAdapter } from "./grok.js";
import type { MCPServerDefinition } from "../types/index.js";

describe("GrokMCPAdapter", () => {
  let adapter: GrokMCPAdapter;
  const stdio: MCPServerDefinition = {
    id: "context7",
    name: "context7",
    transport: {
      type: "stdio",
      command: "/usr/local/bin/op-mcp-run-grok",
      args: ["npx", "-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_API_KEY: "op://mcp-secrets/Context7 API Key/password" },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new GrokMCPAdapter();
  });

  it("uses Grok native TOML paths", () => {
    expect(adapter.id).toBe("grok");
    expect(adapter.name).toBe("Grok");
    expect(adapter.configPath).toBe(".grok/config.toml");
    expect(adapter.userConfigPath).toBe(`${homedir()}/.grok/config.toml`);
    expect(adapter.command).toBe("grok");
  });

  it("generates [mcp_servers] TOML, not JSON", async () => {
    const files = await adapter.generate([stdio]);
    expect(files[0]?.path).toBe(".grok/config.toml");
    expect(files[0]?.format).toBe("toml");
    expect(files[0]?.content).toContain("[mcp_servers.context7]");
    expect(files[0]?.content).toContain("[mcp_servers.context7.env]");
    expect(files[0]?.content).toContain('command = "/usr/local/bin/op-mcp-run-grok"');
    expect(files[0]?.content).toContain('args = ["npx", "-y", "@upstash/context7-mcp"]');
    expect(files[0]?.content).not.toContain("mcpServers");
  });

  it("generates url remotes with headers", async () => {
    const files = await adapter.generate([
      {
        id: "linear",
        name: "linear",
        transport: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer token" },
        },
      },
    ]);
    expect(files[0]?.content).toContain("[mcp_servers.linear]");
    expect(files[0]?.content).toContain('url = "https://mcp.linear.app/mcp"');
    expect(files[0]?.content).toContain("[mcp_servers.linear.headers]");
    expect(files[0]?.content).toContain('Authorization = "Bearer token"');
  });

  it("generates quoted tables for names with spaces", async () => {
    const files = await adapter.generate([
      {
        id: "Workspace - Demo Org",
        name: "Workspace - Demo Org",
        transport: { type: "stdio", command: "/bin/workspace-mcp-demo" },
      },
    ]);
    expect(files[0]?.content).toContain('[mcp_servers."Workspace - Demo Org"]');
  });

  it("imports nothing when neither config exists", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(await adapter.import("/tmp/project")).toEqual([]);
  });

  it("imports project TOML servers", async () => {
    vi.mocked(existsSync).mockImplementation((path) =>
      String(path).replaceAll("\\", "/").endsWith(".grok/config.toml"),
    );
    vi.mocked(readFile).mockResolvedValue(`[mcp_servers.github]
command = "gh-mcp"
`);
    const servers = await adapter.import("/tmp/project");
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe("github");
    expect(servers[0]?.transport).toEqual({ type: "stdio", command: "gh-mcp" });
  });

  it("merges into an existing user config instead of replacing it", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue(`[ui]\nyolo = false\n`);
    const files = await adapter.generate([stdio]);
    await adapter.install(files, "/tmp/project");
    const written = String(vi.mocked(writeFile).mock.calls[0]?.[1]);
    expect(written).toContain("[ui]");
    expect(written).toContain("yolo = false");
    expect(written).toContain("[mcp_servers.context7]");
    expect(vi.mocked(mkdir)).toHaveBeenCalled();
  });
});
