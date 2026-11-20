import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { MCPServerDefinition, MCPTransport, GeneratedFile } from "../types/index.js";
import { mergeMcpServersJson, type McpServersMap } from "./mcp-servers-json.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const ROO_EXTENSION_ID = "rooveterinaryinc.roo-cline";
const ROO_PRESERVED_FIELDS = ["alwaysAllow", "disabled", "timeout"] as const;

export function resolveRooCodeUserConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    return join(
      appData,
      "Code",
      "User",
      "globalStorage",
      ROO_EXTENSION_ID,
      "settings",
      "mcp_settings.json",
    );
  }

  if (platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      ROO_EXTENSION_ID,
      "settings",
      "mcp_settings.json",
    );
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(
    xdgConfigHome,
    "Code",
    "User",
    "globalStorage",
    ROO_EXTENSION_ID,
    "settings",
    "mcp_settings.json",
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === "string");
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string")) return undefined;
  return value;
}

function preserveRooFields(existingRaw: string, generatedRaw: string): string {
  try {
    const existing = JSON.parse(existingRaw) as { mcpServers?: McpServersMap };
    const generated = JSON.parse(generatedRaw) as { mcpServers?: McpServersMap };
    const currentServers = existing.mcpServers;
    const incomingServers = generated.mcpServers;

    if (
      !currentServers ||
      typeof currentServers !== "object" ||
      Array.isArray(currentServers) ||
      !incomingServers ||
      typeof incomingServers !== "object" ||
      Array.isArray(incomingServers)
    ) {
      return generatedRaw;
    }

    for (const [id, incomingConfig] of Object.entries(incomingServers)) {
      const existingConfig = currentServers[id];
      if (!existingConfig || typeof existingConfig !== "object" || Array.isArray(existingConfig)) {
        continue;
      }
      for (const field of ROO_PRESERVED_FIELDS) {
        if (existingConfig[field] !== undefined && incomingConfig[field] === undefined) {
          incomingConfig[field] = existingConfig[field];
        }
      }
    }

    return JSON.stringify(generated, null, 2) + "\n";
  } catch {
    return generatedRaw;
  }
}

class RooCodeMCPAdapter extends BaseMCPAdapter {
  readonly id = "roo-code";
  readonly name = "Roo Code";
  readonly nativeSupport = true;
  readonly configPath = ".roo/mcp.json";
  override readonly userConfigPath: string;

  constructor(userConfigPath?: string) {
    super();
    this.userConfigPath = userConfigPath ?? resolveRooCodeUserConfigPath();
  }

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    const mcpServers: Record<string, unknown> = {};
    for (const server of servers) {
      if (server.transport.type === "stdio") {
        mcpServers[server.id] = {
          command: server.transport.command,
          args: server.transport.args ?? [],
          env: server.transport.env ?? {},
        };
      } else if (server.transport.type === "http") {
        mcpServers[server.id] = {
          type: "streamable-http",
          url: server.transport.url,
          headers: server.transport.headers ?? {},
        };
      } else {
        mcpServers[server.id] = {
          type: "sse",
          url: server.transport.url,
          headers: server.transport.headers ?? {},
        };
      }
    }
    return [
      {
        path: this.configPath,
        content: JSON.stringify({ mcpServers }, null, 2) + "\n",
        format: "json",
      },
    ];
  }

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const dir = cwd ?? process.cwd();
    return this.readMcpServers(resolve(dir, this.configPath));
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    return this.readMcpServers(this.userConfigPath);
  }

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    return (
      existsSync(resolve(dir, this.configPath)) ||
      existsSync(resolve(dir, ".roo")) ||
      existsSync(this.userConfigPath)
    );
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = isAbsolute(file.path) ? file.path : resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      let content = file.content;
      if (existsSync(fullPath)) {
        const existingRaw = await readFile(fullPath, "utf-8");
        const prepared = preserveRooFields(existingRaw, file.content);
        content = mergeMcpServersJson(existingRaw, prepared);
      }
      await writeFile(fullPath, content, "utf-8");
    }
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, this.configPath);
    if (existsSync(fullPath)) {
      await rm(fullPath, { force: true });
    }
  }

  private async readMcpServers(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    const raw = await readFile(fullPath, "utf-8");
    const data = JSON.parse(raw) as { mcpServers?: McpServersMap };
    const servers: MCPServerDefinition[] = [];

    for (const [id, config] of Object.entries(data.mcpServers ?? {})) {
      if (!config || typeof config !== "object") continue;

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
        const type = config.type === "streamable-http" || config.type === "http" ? "http" : "sse";
        const transport: Extract<MCPTransport, { url: string }> = {
          type,
          url: config.url,
        };
        if (isStringRecord(config.headers)) transport.headers = config.headers;
        servers.push({ id, name: id, transport });
      }
    }

    return servers;
  }
}

const adapter = new RooCodeMCPAdapter();
registry.register(adapter);

export { RooCodeMCPAdapter };
export default adapter;
