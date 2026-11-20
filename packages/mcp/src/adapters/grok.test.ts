import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { GrokMCPAdapter } from "./grok.js";
import type { MCPServerDefinition } from "../types/index.js";

describe("GrokMCPAdapter", () => {
  let adapter: GrokMCPAdapter;
  let tmp: string;

  const stdio: MCPServerDefinition = {
    id: "context7",
    name: "context7",
    transport: {
      type: "stdio",
      command: "/usr/local/bin/mcp-wrapper",
      args: ["npx", "-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_API_KEY: "test-api-key" },
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new GrokMCPAdapter();
    tmp = await mkdtemp(join(tmpdir(), "grok-mcp-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("uses Grok native TOML paths", () => {
    expect(adapter.id).toBe("grok");
    expect(adapter.name).toBe("Grok");
    expect(adapter.configPath).toBe(".grok/config.toml");
    expect(adapter.userConfigPath).toBe(join(homedir(), ".grok", "config.toml"));
    expect(adapter.command).toBe("grok");
  });

  it("generates [mcp_servers] TOML, not JSON", async () => {
    const files = await adapter.generate([stdio]);
    expect(files[0]?.path).toBe(".grok/config.toml");
    expect(files[0]?.format).toBe("toml");
    expect(files[0]?.content).toContain("[mcp_servers.context7]");
    expect(files[0]?.content).toContain("[mcp_servers.context7.env]");
    expect(files[0]?.content).toContain('command = "/usr/local/bin/mcp-wrapper"');
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
        id: "My Docs Server",
        name: "My Docs Server",
        transport: { type: "stdio", command: "/usr/local/bin/docs-mcp" },
      },
    ]);
    expect(files[0]?.content).toContain('[mcp_servers."My Docs Server"]');
  });

  it("imports nothing when config does not exist", async () => {
    expect(await adapter.import(tmp)).toEqual([]);
  });

  it("imports project TOML servers from disk", async () => {
    await mkdir(join(tmp, ".grok"), { recursive: true });
    await writeFile(
      join(tmp, ".grok", "config.toml"),
      `[mcp_servers.github]\ncommand = "gh-mcp"\n`,
      "utf-8",
    );
    const servers = await adapter.import(tmp);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe("github");
    expect(servers[0]?.transport).toEqual({ type: "stdio", command: "gh-mcp" });
  });

  it("merges into an existing config instead of replacing non-MCP tables", async () => {
    const configPath = join(tmp, ".grok", "config.toml");
    await mkdir(join(tmp, ".grok"), { recursive: true });
    await writeFile(configPath, `[ui]\nyolo = false\n\n[model]\nname = "grok-3"\n`, "utf-8");

    const files = await adapter.generate([stdio]);
    await adapter.install(files, tmp);

    const written = await readFile(configPath, "utf-8");
    expect(written).toContain("[ui]");
    expect(written).toContain("yolo = false");
    expect(written).toContain("[model]");
    expect(written).toContain('name = "grok-3"');
    expect(written).toContain("[mcp_servers.context7]");
  });

  it("uninstall preserves non-MCP tables like [ui], [model], and [permission]", async () => {
    const configPath = join(tmp, ".grok", "config.toml");
    await mkdir(join(tmp, ".grok"), { recursive: true });
    await writeFile(
      configPath,
      `[ui]
yolo = false

[model]
name = "grok-3"

[permission]
mode = "ask"

[mcp_servers.context7]
command = "/usr/local/bin/mcp-wrapper"

[mcp_servers.context7.env]
CONTEXT7_API_KEY = "test-api-key"
`,
      "utf-8",
    );

    await adapter.uninstall(tmp);

    expect(existsSync(configPath)).toBe(true);
    const remaining = await readFile(configPath, "utf-8");
    expect(remaining).toContain("[ui]");
    expect(remaining).toContain("yolo = false");
    expect(remaining).toContain("[model]");
    expect(remaining).toContain('name = "grok-3"');
    expect(remaining).toContain("[permission]");
    expect(remaining).toContain('mode = "ask"');
    expect(remaining).not.toContain("[mcp_servers");
    expect(remaining).not.toContain("context7");
  });

  it("uninstall removes .grok/config.toml when only MCP tables were present", async () => {
    const configPath = join(tmp, ".grok", "config.toml");
    const files = await adapter.generate([stdio]);
    await adapter.install(files, tmp);
    expect(existsSync(configPath)).toBe(true);

    await adapter.uninstall(tmp);
    expect(existsSync(configPath)).toBe(false);
  });

  it("uninstall is a no-op when .grok/config.toml does not exist", async () => {
    await expect(adapter.uninstall(tmp)).resolves.toBeUndefined();
  });
});
