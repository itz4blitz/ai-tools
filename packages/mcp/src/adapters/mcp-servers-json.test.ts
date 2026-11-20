import { describe, expect, it } from "vitest";
import {
  encodeMcpServersFile,
  fromMcpServersMap,
  mergeMcpServersJson,
  toMcpServersMap,
} from "./mcp-servers-json.js";
import type { MCPServerDefinition } from "../types/index.js";

const stdio: MCPServerDefinition = {
  id: "github",
  name: "github",
  transport: { type: "stdio", command: "gh-mcp", args: [], env: { A: "1" } },
};

const http: MCPServerDefinition = {
  id: "linear",
  name: "linear",
  transport: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "x" } },
};

describe("mcp-servers-json", () => {
  it("encodes http/sse type and round-trips through JSON", () => {
    const encoded = encodeMcpServersFile([stdio, http]);
    const parsed = JSON.parse(encoded) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(parsed.mcpServers.linear?.type).toBe("http");
    expect(fromMcpServersMap(parsed.mcpServers).map((s) => s.transport.type)).toEqual([
      "stdio",
      "http",
    ]);
  });

  it("imports url without type as sse", () => {
    const servers = fromMcpServersMap({ hosted: { url: "https://example.com/sse" } });
    expect(servers[0]?.transport).toEqual({ type: "sse", url: "https://example.com/sse" });
  });

  it("maps streamable-http and streamableHttp to http (not sse)", () => {
    const servers = fromMcpServersMap({
      kebab: { type: "streamable-http", url: "https://example.com/mcp" },
      camel: { type: "streamableHttp", url: "https://example.com/mcp2" },
    });
    expect(servers.find((s) => s.id === "kebab")?.transport).toEqual({
      type: "http",
      url: "https://example.com/mcp",
    });
    expect(servers.find((s) => s.id === "camel")?.transport).toEqual({
      type: "http",
      url: "https://example.com/mcp2",
    });
  });

  it("skips entries that have neither command nor url", () => {
    expect(fromMcpServersMap({ broken: { type: "http" } })).toEqual([]);
  });

  it("merges mcpServers without clobbering sibling keys", () => {
    const merged = mergeMcpServersJson(
      JSON.stringify({ theme: "dark", mcpServers: { keep: { command: "old" } } }),
      encodeMcpServersFile([stdio]),
    );
    const parsed = JSON.parse(merged) as {
      theme: string;
      mcpServers: Record<string, { command?: string }>;
    };
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers.keep?.command).toBe("old");
    expect(parsed.mcpServers.github?.command).toBe("gh-mcp");
  });

  it("creates mcpServers when the existing file lacks a valid map", () => {
    const merged = mergeMcpServersJson(
      JSON.stringify({ theme: "dark", mcpServers: 1 }),
      encodeMcpServersFile([stdio]),
    );
    const parsed = JSON.parse(merged) as { theme: string; mcpServers: Record<string, unknown> };
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers.github).toBeDefined();
  });

  it("omits invalid args/env/headers on import", () => {
    const servers = fromMcpServersMap({
      github: { command: "gh-mcp", args: [1, 2], env: "nope" },
      linear: { type: "http", url: "https://x", headers: ["nope"] },
    });
    expect(servers[0]?.transport).toEqual({ type: "stdio", command: "gh-mcp" });
    expect(servers[1]?.transport).toEqual({ type: "http", url: "https://x" });
  });

  it("exposes toMcpServersMap for stdio defaults", () => {
    expect(
      toMcpServersMap([{ id: "x", name: "x", transport: { type: "stdio", command: "npx" } }]),
    ).toEqual({
      x: { command: "npx", args: [], env: {} },
    });
  });

  it("round-trips explicit sse type", () => {
    const sse: MCPServerDefinition = {
      id: "events",
      name: "events",
      transport: { type: "sse", url: "http://localhost:3000/sse" },
    };
    const map = toMcpServersMap([sse]);
    expect(map.events?.type).toBe("sse");
    expect(fromMcpServersMap(map)[0]?.transport.type).toBe("sse");
  });

  it("merges when generated JSON has no mcpServers key", () => {
    const merged = mergeMcpServersJson(JSON.stringify({ theme: "dark" }), "{}");
    expect(JSON.parse(merged)).toEqual({ theme: "dark", mcpServers: {} });
  });
});
