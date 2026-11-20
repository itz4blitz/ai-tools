import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GeneratedFile, MCPServerDefinition, MCPTransport } from "../types/index.js";
import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";

const MCP_SERVERS_KEY = "amp.mcpServers";

type AmpServerEntry = {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  type?: unknown;
  headers?: unknown;
};

export function resolveAmpUserConfigPath(): string {
  const override = process.env.AMP_SETTINGS_FILE?.trim();
  if (override) return resolve(override);

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) return join(xdgConfigHome, "amp", "settings.json");

  return join(homedir(), ".config", "amp", "settings.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isPlainObject(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Strip JSONC single-line (`//`), multi-line (`/* ... *\/`) comments,
 * and trailing commas outside string literals.
 */
export function stripJsoncComments(raw: string): string {
  let noComments = "";
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw.charAt(i);
    const next = raw[i + 1];

    if (inString) {
      noComments += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      noComments += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < raw.length && raw[i] !== "\n") {
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }

    noComments += ch;
    i++;
  }

  // Strip trailing commas before `}` or `]` outside string literals.
  let cleaned = "";
  inString = false;
  escaped = false;
  for (let j = 0; j < noComments.length; j++) {
    const ch = noComments.charAt(j);
    if (inString) {
      cleaned += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }

    if (ch === ",") {
      let lookahead = j + 1;
      while (lookahead < noComments.length && /\s/.test(noComments.charAt(lookahead))) {
        lookahead++;
      }
      const nextToken = noComments[lookahead];
      if (nextToken === "}" || nextToken === "]") {
        continue;
      }
    }

    cleaned += ch;
  }

  return cleaned;
}

function parseJsoncObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stripJsoncComments(raw));
  return isPlainObject(parsed) ? parsed : {};
}

function toAmpMcpServers(servers: MCPServerDefinition[]): Record<string, Record<string, unknown>> {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    if (server.transport.type === "stdio") {
      const entry: Record<string, unknown> = {
        command: server.transport.command,
      };
      if (server.transport.args && server.transport.args.length > 0) {
        entry.args = server.transport.args;
      }
      if (server.transport.env && Object.keys(server.transport.env).length > 0) {
        entry.env = server.transport.env;
      }
      mcpServers[server.id] = entry;
    } else {
      const entry: Record<string, unknown> = {
        type: server.transport.type,
        url: server.transport.url,
      };
      if (server.transport.headers && Object.keys(server.transport.headers).length > 0) {
        entry.headers = server.transport.headers;
      }
      mcpServers[server.id] = entry;
    }
  }
  return mcpServers;
}

function fromAmpMcpServers(mcpServers: Record<string, unknown>): MCPServerDefinition[] {
  const servers: MCPServerDefinition[] = [];
  for (const [id, rawEntry] of Object.entries(mcpServers)) {
    if (!isPlainObject(rawEntry)) continue;
    const config = rawEntry as AmpServerEntry;
    if (typeof config.command === "string") {
      const transport: Extract<MCPTransport, { type: "stdio" }> = {
        type: "stdio",
        command: config.command,
      };
      if (isStringArray(config.args) && config.args.length > 0) {
        transport.args = config.args;
      }
      if (isStringRecord(config.env) && Object.keys(config.env).length > 0) {
        transport.env = config.env;
      }
      servers.push({ id, name: id, transport });
    } else if (typeof config.url === "string") {
      const transportType = config.type === "sse" ? "sse" : "http";
      const transport: Extract<MCPTransport, { url: string }> = {
        type: transportType,
        url: config.url,
      };
      if (isStringRecord(config.headers) && Object.keys(config.headers).length > 0) {
        transport.headers = config.headers;
      }
      servers.push({ id, name: id, transport });
    }
  }
  return servers;
}

class AmpMCPAdapter extends BaseMCPAdapter {
  readonly id = "amp";
  readonly name = "Amp";
  readonly nativeSupport = true;
  readonly configPath = ".amp/settings.json";
  readonly userConfigPath = resolveAmpUserConfigPath();
  readonly command = "amp";

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    return [
      {
        path: this.configPath,
        content: `${JSON.stringify({ [MCP_SERVERS_KEY]: toAmpMcpServers(servers) }, null, 2)}\n`,
        format: "json",
      },
    ];
  }

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const dir = cwd ?? process.cwd();
    return this.readSettings(resolve(dir, this.configPath));
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    return this.readSettings(this.userConfigPath);
  }

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configPath))) return true;
    if (existsSync(this.userConfigPath)) return true;
    return this.commandExists(this.command);
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = isAbsolute(file.path) ? file.path : resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      if (existsSync(fullPath)) {
        const existing = parseJsoncObject(await readFile(fullPath, "utf-8"));
        const generated = parseJsoncObject(file.content);
        const currentServers = isPlainObject(existing[MCP_SERVERS_KEY])
          ? existing[MCP_SERVERS_KEY]
          : {};
        const nextServers = isPlainObject(generated[MCP_SERVERS_KEY])
          ? generated[MCP_SERVERS_KEY]
          : {};
        existing[MCP_SERVERS_KEY] = { ...currentServers, ...nextServers };
        await writeFile(fullPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
        continue;
      }
      await writeFile(fullPath, file.content, "utf-8");
    }
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, this.configPath);
    if (!existsSync(fullPath)) return;

    const existing = parseJsoncObject(await readFile(fullPath, "utf-8"));
    delete existing[MCP_SERVERS_KEY];

    if (Object.keys(existing).length === 0) {
      await rm(fullPath);
      return;
    }

    await writeFile(fullPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
  }

  private async readSettings(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    const data = parseJsoncObject(await readFile(fullPath, "utf-8"));
    const mcpServers = data[MCP_SERVERS_KEY];
    if (!isPlainObject(mcpServers)) return [];
    return fromAmpMcpServers(mcpServers);
  }
}

const adapter = new AmpMCPAdapter();
registry.register(adapter);

export { AmpMCPAdapter };
export default adapter;
