import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";
import { mergeMcpServersJson } from "./mcp-servers-json.js";
import type { MCPServerDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type ResolveClineMcpPathOptions = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
};

function getVscodeGlobalStorageRoot(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev",
    );
  }
  if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  }
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(xdgConfig, "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
}

/**
 * Resolve Cline's user-level MCP settings path across platforms and installs:
 * 1. `CLINE_MCP_SETTINGS_PATH` environment override
 * 2. VS Code `globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`
 * 3. Cline CLI `~/.cline/data/settings/cline_mcp_settings.json`
 */
export function resolveClineMcpSettingsPath(options: ResolveClineMcpPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  const envOverride = env.CLINE_MCP_SETTINGS_PATH?.trim();
  if (envOverride) return envOverride;

  const vscodeStorage = getVscodeGlobalStorageRoot(platform, home, env);
  const vscodeSettings = join(vscodeStorage, "settings", "cline_mcp_settings.json");
  const cliSettings = join(home, ".cline", "data", "settings", "cline_mcp_settings.json");

  if (exists(vscodeSettings)) return vscodeSettings;
  if (exists(cliSettings)) return cliSettings;
  if (exists(join(home, ".cline")) && !exists(vscodeStorage)) return cliSettings;

  return vscodeSettings;
}

class ClineMCPAdapter extends BaseMCPAdapter {
  readonly id = "cline";
  readonly name = "Cline";
  readonly nativeSupport = true;
  readonly configPath = ".cline/mcp_settings.json";
  override readonly userConfigPath = resolveClineMcpSettingsPath();
  readonly command = "cline";

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    const mcpServers: Record<string, unknown> = {};
    for (const server of servers) {
      const disabledField = server.enabled !== undefined ? { disabled: !server.enabled } : {};

      if (server.transport.type === "stdio") {
        mcpServers[server.id] = {
          command: server.transport.command,
          args: server.transport.args ?? [],
          env: server.transport.env ?? {},
          ...disabledField,
        };
      } else {
        mcpServers[server.id] = {
          type: server.transport.type === "http" ? "streamableHttp" : "sse",
          url: server.transport.url,
          headers: server.transport.headers ?? {},
          ...disabledField,
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

  /** Merge into existing Cline MCP settings so user-configured servers are never wiped. */
  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = isAbsolute(file.path) ? file.path : resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      let content = file.content;
      if (existsSync(fullPath)) {
        const existing = await readFile(fullPath, "utf-8");
        content = mergeMcpServersJson(existing, file.content);
      }
      await writeFile(fullPath, content, "utf-8");
    }
  }

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const dir = cwd ?? process.cwd();
    return this.readMcpServers(resolve(dir, this.configPath));
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    return this.readMcpServers(resolveClineMcpSettingsPath());
  }

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configPath))) return true;
    if (existsSync(resolveClineMcpSettingsPath())) return true;
    const vscodeStorage = getVscodeGlobalStorageRoot(process.platform, homedir(), process.env);
    if (existsSync(vscodeStorage)) return true;
    if (existsSync(join(homedir(), ".cline"))) return true;
    return this.commandExists(this.command);
  }

  /** Safely uninstall project MCP settings without deleting unrelated keys. */
  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, this.configPath);
    if (!existsSync(fullPath)) return;

    try {
      const raw = await readFile(fullPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const otherKeys = Object.keys(parsed).filter((key) => key !== "mcpServers");
      if (otherKeys.length > 0) {
        delete parsed.mcpServers;
        await writeFile(fullPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
        return;
      }
    } catch {
      // Malformed JSON: fall through to removing the file
    }

    await rm(fullPath);
  }

  private async readMcpServers(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    const raw = await readFile(fullPath, "utf-8");
    const data = JSON.parse(raw) as { mcpServers?: Record<string, Record<string, unknown>> };
    const servers: MCPServerDefinition[] = [];
    for (const [id, config] of Object.entries(data.mcpServers ?? {})) {
      if (!config || typeof config !== "object") continue;
      const enabled = typeof config.disabled === "boolean" ? !config.disabled : undefined;
      const base = { id, name: id, ...(enabled !== undefined ? { enabled } : {}) };

      if (typeof config.command === "string") {
        servers.push({
          ...base,
          transport: {
            type: "stdio",
            command: config.command,
            args: config.args as string[] | undefined,
            env: config.env as Record<string, string> | undefined,
          },
        });
      } else if (typeof config.url === "string") {
        const transportType =
          config.type === "streamableHttp" || config.type === "http" ? "http" : "sse";
        servers.push({
          ...base,
          transport: {
            type: transportType,
            url: config.url,
            headers: config.headers as Record<string, string> | undefined,
          },
        });
      }
    }
    return servers;
  }
}

const adapter = new ClineMCPAdapter();
registry.register(adapter);

export { ClineMCPAdapter };
export default adapter;
