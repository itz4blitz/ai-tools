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
import { ZcodeMCPAdapter } from "./zcode.js";
import type { MCPServerDefinition } from "../types/index.js";

describe("ZcodeMCPAdapter", () => {
  let adapter: ZcodeMCPAdapter;
  const stdio: MCPServerDefinition = {
    id: "github",
    name: "github",
    transport: { type: "stdio", command: "/usr/local/bin/gh-mcp", args: [] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ZcodeMCPAdapter();
  });

  it("uses ZCode user and project paths", () => {
    expect(adapter.id).toBe("zcode");
    expect(adapter.name).toBe("ZCode");
    expect(adapter.configPath).toBe(".zcode/config.json");
    expect(adapter.userConfigPath).toBe(`${homedir()}/.zcode/cli/config.json`);
    expect(adapter.command).toBe("zcode");
  });

  it("detects ZCode from the user config even without a zcode binary", async () => {
    vi.mocked(existsSync).mockImplementation((path) => String(path).endsWith("cli/config.json"));
    expect(await adapter.detect("/tmp/empty")).toBe(true);
  });

  it("generates project { mcp: { servers } } JSON, not mcpServers", async () => {
    const files = await adapter.generate([stdio]);
    expect(files[0]?.path).toBe(".zcode/config.json");
    const parsed = JSON.parse(files[0]!.content) as {
      mcp: { servers: Record<string, { command: string; type: string; args: string[] }> };
    };
    expect(parsed.mcp.servers.github?.type).toBe("stdio");
    expect(parsed.mcp.servers.github?.command).toBe("/usr/local/bin/gh-mcp");
    expect(parsed.mcp.servers.github?.args).toEqual([]);
    expect(files[0]!.content).not.toContain("mcpServers");
  });

  it("emits type http/sse for remotes", async () => {
    const files = await adapter.generate([
      {
        id: "linear",
        name: "linear",
        transport: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer x" },
        },
      },
      {
        id: "events",
        name: "events",
        transport: { type: "sse", url: "http://localhost:3000/sse" },
      },
    ]);
    const parsed = JSON.parse(files[0]!.content) as {
      mcp: { servers: Record<string, Record<string, unknown>> };
    };
    expect(parsed.mcp.servers.linear).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer x" },
    });
    expect(parsed.mcp.servers.events).toMatchObject({
      type: "sse",
      url: "http://localhost:3000/sse",
    });
  });

  it("imports user mcp.servers without clobbering other config keys", async () => {
    vi.mocked(existsSync).mockImplementation((path) => String(path).endsWith("config.json"));
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        model: "keep-me",
        mcp: {
          servers: {
            acme: {
              type: "stdio",
              command: "/usr/local/bin/acme-mcp-stdio",
              args: [],
              env: { OP_ACCOUNT: "acme.1password.com" },
            },
          },
        },
      }),
    );
    const servers = await adapter.importUser();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.id).toBe("acme");
    expect(servers[0]?.transport.type).toBe("stdio");
  });

  it("merges generated servers into existing user config.json", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({ model: "keep-me", mcp: { servers: {} } }),
    );
    const files = await adapter.generate([stdio]);
    files[0]!.path = `${homedir()}/.zcode/cli/config.json`;
    await adapter.install(files, "/tmp");
    const written = JSON.parse(String(vi.mocked(writeFile).mock.calls[0]?.[1])) as {
      model: string;
      mcp: { servers: Record<string, { command: string; type: string }> };
    };
    expect(written.model).toBe("keep-me");
    expect(written.mcp.servers.github?.type).toBe("stdio");
    expect(written.mcp.servers.github?.command).toBe("/usr/local/bin/gh-mcp");
    expect(vi.mocked(mkdir)).toHaveBeenCalled();
  });
});
