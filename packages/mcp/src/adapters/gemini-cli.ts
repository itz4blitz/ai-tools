import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { MCPServerDefinition, GeneratedFile } from "../types/index.js";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { mergeMcpServersJson } from "./mcp-servers-json.js";

class GeminiCliMCPAdapter extends BaseMCPAdapter {
  readonly id = "gemini-cli";
  readonly name = "Gemini CLI";
  readonly nativeSupport = true;
  readonly configPath = ".gemini/settings.json";
  readonly userConfigPath = `${homedir()}/.gemini/settings.json`;
  readonly command = "gemini";

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    const mcpServers: Record<string, unknown> = {};
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

  /** settings.json also holds auth, theme and other Gemini settings: merge, never overwrite. */
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

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const dir = cwd ?? process.cwd();
    return this.readMcpServers(resolve(dir, this.configPath));
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    return this.readMcpServers(this.userConfigPath);
  }

  private async readMcpServers(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    const raw = await readFile(fullPath, "utf-8");
    const data = JSON.parse(raw) as { mcpServers?: Record<string, Record<string, unknown>> };
    const servers: MCPServerDefinition[] = [];
    for (const [id, config] of Object.entries(data.mcpServers ?? {})) {
      if (config.command) {
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
      } else if (config.url) {
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

const adapter = new GeminiCliMCPAdapter();
registry.register(adapter);

export { GeminiCliMCPAdapter };
export default adapter;
