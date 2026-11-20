import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, MCPServerDefinition } from "../types/index.js";
import { fromMcpServersMap, mergeMcpServersJson, type McpServersMap } from "./mcp-servers-json.js";

class KiroMCPAdapter extends BaseMCPAdapter {
  readonly id = "kiro";
  readonly name = "Kiro";
  readonly nativeSupport = true;
  readonly configPath = ".kiro/settings/mcp.json";
  override readonly userConfigPath = join(homedir(), ".kiro", "settings", "mcp.json");
  override readonly command = "kiro";

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    const mcpServers: McpServersMap = {};
    for (const server of servers) {
      let entry: Record<string, unknown>;
      if (server.transport.type === "stdio") {
        entry = {
          command: server.transport.command,
          args: server.transport.args ?? [],
          env: server.transport.env ?? {},
        };
      } else {
        entry = {
          type: server.transport.type,
          url: server.transport.url,
          headers: server.transport.headers ?? {},
        };
      }
      if (server.enabled === false) {
        entry.disabled = true;
      }
      mcpServers[server.id] = entry;
    }

    return [
      {
        path: this.configPath,
        content: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
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
    if (existsSync(resolve(dir, this.configPath))) return true;
    return (await this.commandExists("kiro")) || (await this.commandExists("kiro-cli"));
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = isAbsolute(file.path) ? file.path : resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      let content = file.content;
      if (existsSync(fullPath)) {
        content = mergeMcpServersJson(await readFile(fullPath, "utf-8"), file.content);
      }
      await writeFile(fullPath, content, "utf-8");
    }
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, this.configPath);
    if (!existsSync(fullPath)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(fullPath, "utf-8"));
    } catch {
      return;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const record = parsed as Record<string, unknown>;
    if (!("mcpServers" in record)) {
      return;
    }

    const { mcpServers: _removed, ...rest } = record;
    if (Object.keys(rest).length === 0) {
      await rm(fullPath, { force: true });
    } else {
      await writeFile(fullPath, `${JSON.stringify(rest, null, 2)}\n`, "utf-8");
    }
  }

  private async readMcpServers(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    const data = JSON.parse(await readFile(fullPath, "utf-8")) as { mcpServers?: McpServersMap };
    const rawMap = data.mcpServers ?? {};
    return fromMcpServersMap(rawMap).map((server) => {
      if (rawMap[server.id]?.disabled === true) {
        return { ...server, enabled: false };
      }
      return server;
    });
  }
}

const adapter = new KiroMCPAdapter();
registry.register(adapter);

export { KiroMCPAdapter };
export default adapter;
