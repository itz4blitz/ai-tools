import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { GeneratedFile, MCPServerDefinition, MCPTransport } from "../types/index.js";
import { BaseMCPAdapter } from "./base.js";
import { mergeMcpServersJson, type McpServersMap } from "./mcp-servers-json.js";
import { registry } from "./registry.js";

const PLUGIN_DIR = ".agents/plugins/ai-tools";
const PLUGIN_MANIFEST_PATH = `${PLUGIN_DIR}/plugin.json`;

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string")) return undefined;
  return value;
}

export class AntigravityCliMCPAdapter extends BaseMCPAdapter {
  readonly id = "antigravity-cli";
  readonly name = "Antigravity CLI";
  readonly nativeSupport = true;
  readonly configPath = `${PLUGIN_DIR}/mcp_config.json`;
  override readonly userConfigPath = join(homedir(), ".gemini", "config", "mcp_config.json");
  override readonly command = "agy";

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configPath))) return true;
    if (existsSync(this.userConfigPath)) return true;
    if (existsSync(join(homedir(), ".gemini", "antigravity-cli", "settings.json"))) return true;
    return this.commandExists(this.command);
  }

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    const mcpServers: McpServersMap = {};
    for (const server of servers) {
      if (server.transport.type === "stdio") {
        mcpServers[server.id] = {
          command: server.transport.command,
          args: server.transport.args ?? [],
          ...(server.transport.env && Object.keys(server.transport.env).length > 0
            ? { env: server.transport.env }
            : {}),
        };
      } else {
        mcpServers[server.id] = {
          url: server.transport.url,
          ...(server.transport.headers && Object.keys(server.transport.headers).length > 0
            ? { headers: server.transport.headers }
            : {}),
        };
      }
    }

    return [
      {
        path: this.configPath,
        content: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
        format: "json",
      },
      {
        path: PLUGIN_MANIFEST_PATH,
        content: `${JSON.stringify({ name: "ai-tools" }, null, 2)}\n`,
        format: "json",
      },
    ];
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = isAbsolute(file.path) ? file.path : resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      let content = file.content;
      if (file.path.endsWith("mcp_config.json") && existsSync(fullPath)) {
        content = mergeMcpServersJson(await readFile(fullPath, "utf-8"), file.content);
      }
      await writeFile(fullPath, content, "utf-8");
    }
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const configFullPath = resolve(dir, this.configPath);
    const manifestFullPath = resolve(dir, PLUGIN_MANIFEST_PATH);
    const pluginDirFullPath = resolve(dir, PLUGIN_DIR);

    if (existsSync(configFullPath)) {
      await rm(configFullPath, { force: true });
    }
    if (existsSync(manifestFullPath)) {
      await rm(manifestFullPath, { force: true });
    }
    if (existsSync(pluginDirFullPath)) {
      const remaining = await readdir(pluginDirFullPath);
      if (remaining.length === 0) {
        await rm(pluginDirFullPath, { recursive: true, force: true });
      }
    }
  }

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const dir = cwd ?? process.cwd();
    return this.readMcpServers(resolve(dir, this.configPath));
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    return this.readMcpServers(this.userConfigPath);
  }

  private async readMcpServers(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    let data: { mcpServers?: McpServersMap };
    try {
      data = JSON.parse(await readFile(fullPath, "utf-8")) as { mcpServers?: McpServersMap };
    } catch {
      return [];
    }

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
          typeof config.url === "string"
            ? config.url
            : typeof config.serverUrl === "string"
              ? config.serverUrl
              : undefined;
        if (remoteUrl) {
          const type = config.type === "sse" ? "sse" : "http";
          const transport: Extract<MCPTransport, { url: string }> = { type, url: remoteUrl };
          if (isStringRecord(config.headers)) transport.headers = config.headers;
          servers.push({ id, name: id, transport });
        }
      }
    }

    return servers;
  }
}

const adapter = new AntigravityCliMCPAdapter();
registry.register(adapter);

export default adapter;
