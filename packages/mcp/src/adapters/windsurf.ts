import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, MCPServerDefinition, MCPTransport } from "../types/index.js";
import { mergeMcpServersJson, type McpServersMap } from "./mcp-servers-json.js";

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string")) return undefined;
  return value;
}

class WindsurfMCPAdapter extends BaseMCPAdapter {
  readonly id = "windsurf";
  readonly name = "Windsurf";
  readonly nativeSupport = true;
  readonly configPath = ".codeium/windsurf/mcp_config.json";
  readonly scope = "user-only" as const;
  override readonly userConfigPath = join(homedir(), ".codeium", "windsurf", "mcp_config.json");
  override readonly command = "windsurf";

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
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
          serverUrl: server.transport.url,
          headers: server.transport.headers ?? {},
        };
      }
    }
    return [
      {
        path: this.configPath,
        content: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
        format: "json",
      },
    ];
  }

  override async detect(cwd?: string): Promise<boolean> {
    if (existsSync(this.userConfigPath) || existsSync(dirname(this.userConfigPath))) {
      return true;
    }
    if (cwd && existsSync(resolve(cwd, this.configPath))) {
      return true;
    }
    return this.commandExists(this.command);
  }

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const fullPath = cwd ? resolve(cwd, this.configPath) : this.userConfigPath;
    return this.readMcpServers(fullPath);
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    return this.readMcpServers(this.userConfigPath);
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const baseDir = cwd ?? homedir();
    for (const file of files) {
      const fullPath = isAbsolute(file.path) ? file.path : resolve(baseDir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      let content = file.content;
      if (existsSync(fullPath)) {
        content = mergeMcpServersJson(await readFile(fullPath, "utf-8"), file.content);
      }
      await writeFile(fullPath, content, "utf-8");
    }
  }

  override async uninstall(cwd?: string, managedIds?: string[]): Promise<void> {
    const fullPath = cwd ? resolve(cwd, this.configPath) : this.userConfigPath;
    if (!existsSync(fullPath)) return;

    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(fullPath, "utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      data = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const current =
      data.mcpServers !== null &&
      typeof data.mcpServers === "object" &&
      !Array.isArray(data.mcpServers)
        ? { ...(data.mcpServers as McpServersMap) }
        : {};

    if (managedIds) {
      for (const id of managedIds) {
        delete current[id];
      }
      data.mcpServers = current;
    } else {
      data.mcpServers = {};
    }

    await writeFile(fullPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  }

  private async readMcpServers(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    const raw = await readFile(fullPath, "utf-8");
    const data = JSON.parse(raw) as { mcpServers?: McpServersMap };
    const servers: MCPServerDefinition[] = [];

    for (const [id, config] of Object.entries(data.mcpServers ?? {})) {
      if (typeof config.command === "string") {
        const transport: Extract<MCPTransport, { type: "stdio" }> = {
          type: "stdio",
          command: config.command,
        };
        const args = stringArray(config.args);
        if (args) transport.args = args;
        if (isStringRecord(config.env)) transport.env = config.env;
        servers.push({ id, name: id, transport });
      } else {
        const remoteUrl =
          typeof config.serverUrl === "string"
            ? config.serverUrl
            : typeof config.url === "string"
              ? config.url
              : undefined;
        if (remoteUrl) {
          const type = config.type === "http" ? "http" : "sse";
          const transport: Extract<MCPTransport, { url: string }> = { type, url: remoteUrl };
          if (isStringRecord(config.headers)) transport.headers = config.headers;
          servers.push({ id, name: id, transport });
        }
      }
    }

    return servers;
  }
}

const adapter = new WindsurfMCPAdapter();
registry.register(adapter);

export { WindsurfMCPAdapter };
export default adapter;
