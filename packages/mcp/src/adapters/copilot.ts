import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { MCPServerDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function resolveCopilotUserConfigPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Code", "User", "mcp.json");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  return join(home, ".config", "Code", "User", "mcp.json");
}

class CopilotMCPAdapter extends BaseMCPAdapter {
  readonly id = "copilot";
  readonly name = "Copilot";
  readonly nativeSupport = true;
  readonly configPath = ".vscode/mcp.json";
  override readonly userConfigPath = resolveCopilotUserConfigPath();
  override readonly command = "copilot";

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configPath))) return true;
    if (existsSync(this.userConfigPath)) return true;
    if (await this.commandExists("code")) return true;
    return this.commandExists("copilot");
  }

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    const serversObj: Record<string, unknown> = {};
    for (const server of servers) {
      if (server.transport.type === "stdio") {
        serversObj[server.id] = {
          type: "stdio",
          command: server.transport.command,
          args: server.transport.args ?? [],
          env: server.transport.env ?? {},
        };
      } else {
        serversObj[server.id] = {
          type: server.transport.type,
          url: server.transport.url,
          headers: server.transport.headers ?? {},
        };
      }
    }
    return [
      {
        path: this.configPath,
        content: JSON.stringify({ servers: serversObj }, null, 2) + "\n",
        format: "json",
      },
    ];
  }

  /** Merge into existing .vscode/mcp.json, preserving existing `servers` and `inputs`. */
  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = isAbsolute(file.path) ? file.path : resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      let content = file.content;
      if (existsSync(fullPath)) {
        content = mergeCopilotMcpJson(await readFile(fullPath, "utf-8"), file.content);
      }
      await writeFile(fullPath, content, "utf-8");
    }
  }

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const dir = cwd ?? process.cwd();
    return this.readServersFile(resolve(dir, this.configPath));
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    return this.readServersFile(this.userConfigPath);
  }

  /** Safely uninstall: preserve `inputs` or other keys if present; only delete file when empty. */
  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, this.configPath);
    if (!existsSync(fullPath)) return;

    try {
      const raw = await readFile(fullPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const remainingKeys = Object.keys(parsed).filter((key) => key !== "servers");
      if (remainingKeys.length === 0) {
        await rm(fullPath, { force: true });
      } else {
        delete parsed.servers;
        await writeFile(fullPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
      }
    } catch {
      // Leave malformed user files untouched rather than destroying data
    }
  }

  private async readServersFile(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    const raw = await readFile(fullPath, "utf-8");
    const data = JSON.parse(raw) as { servers?: Record<string, Record<string, unknown>> };
    const servers: MCPServerDefinition[] = [];
    for (const [id, config] of Object.entries(data.servers ?? {})) {
      if (config.type === "stdio" || typeof config.command === "string") {
        servers.push({
          id,
          name: id,
          transport: {
            type: "stdio",
            command: config.command as string,
            args: config.args as string[] | undefined,
            env: config.env as Record<string, string> | undefined,
          },
        });
      } else if (config.type === "http" && typeof config.url === "string") {
        servers.push({
          id,
          name: id,
          transport: {
            type: "http",
            url: config.url,
            headers: config.headers as Record<string, string> | undefined,
          },
        });
      } else if (config.type === "sse" || typeof config.url === "string") {
        servers.push({
          id,
          name: id,
          transport: {
            type: "sse",
            url: config.url as string,
            headers: config.headers as Record<string, string> | undefined,
          },
        });
      }
    }
    return servers;
  }
}

function mergeCopilotMcpJson(existingRaw: string, generatedRaw: string): string {
  const existing = JSON.parse(existingRaw) as Record<string, unknown>;
  const generated = JSON.parse(generatedRaw) as { servers?: Record<string, unknown> };
  const currentServers =
    existing.servers !== null &&
    typeof existing.servers === "object" &&
    !Array.isArray(existing.servers)
      ? (existing.servers as Record<string, unknown>)
      : {};
  existing.servers = { ...currentServers, ...generated.servers };
  return JSON.stringify(existing, null, 2) + "\n";
}

const adapter = new CopilotMCPAdapter();
registry.register(adapter);

export { CopilotMCPAdapter };
export default adapter;
