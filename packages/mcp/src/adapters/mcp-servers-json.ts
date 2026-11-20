import type { MCPServerDefinition, MCPTransport } from "../types/index.js";

export type McpServersMap = Record<string, Record<string, unknown>>;

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string")) return undefined;
  return value;
}

export function toMcpServersMap(servers: MCPServerDefinition[]): McpServersMap {
  const mcpServers: McpServersMap = {};
  for (const server of servers) {
    if (server.transport.type === "stdio") {
      mcpServers[server.id] = {
        command: server.transport.command,
        args: server.transport.args ?? [],
        env: server.transport.env ?? {},
      };
    } else {
      mcpServers[server.id] = {
        type: server.transport.type,
        url: server.transport.url,
        headers: server.transport.headers ?? {},
      };
    }
  }
  return mcpServers;
}

export function fromMcpServersMap(mcpServers: McpServersMap): MCPServerDefinition[] {
  const servers: MCPServerDefinition[] = [];
  for (const [id, config] of Object.entries(mcpServers)) {
    if (typeof config.command === "string") {
      const transport: Extract<MCPTransport, { type: "stdio" }> = {
        type: "stdio",
        command: config.command,
      };
      const args = stringArray(config.args);
      if (args) transport.args = args;
      if (isStringRecord(config.env)) transport.env = config.env;
      servers.push({ id, name: id, transport });
    } else if (typeof config.url === "string") {
      const type =
        config.type === "http" ||
        config.type === "streamable-http" ||
        config.type === "streamableHttp"
          ? "http"
          : "sse";
      const transport: Extract<MCPTransport, { url: string }> = { type, url: config.url };
      if (isStringRecord(config.headers)) transport.headers = config.headers;
      servers.push({ id, name: id, transport });
    }
  }
  return servers;
}

export function encodeMcpServersFile(servers: MCPServerDefinition[]): string {
  return `${JSON.stringify({ mcpServers: toMcpServersMap(servers) }, null, 2)}\n`;
}

export function mergeMcpServersJson(existingRaw: string, generatedRaw: string): string {
  const existing = JSON.parse(existingRaw) as Record<string, unknown>;
  const generated = JSON.parse(generatedRaw) as { mcpServers?: McpServersMap };
  const current =
    existing.mcpServers !== null &&
    typeof existing.mcpServers === "object" &&
    !Array.isArray(existing.mcpServers)
      ? (existing.mcpServers as McpServersMap)
      : {};
  existing.mcpServers = { ...current, ...generated.mcpServers };
  return `${JSON.stringify(existing, null, 2)}\n`;
}
