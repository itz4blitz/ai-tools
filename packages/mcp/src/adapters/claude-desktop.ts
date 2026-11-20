import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, MCPServerDefinition } from "../types/index.js";

function resolveClaudeDesktopConfigPath(cwd?: string): string | null {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  }

  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }

  if (cwd) {
    return resolve(cwd, "claude_desktop_config.json");
  }

  return null;
}

class ClaudeDesktopMCPAdapter extends BaseMCPAdapter {
  readonly id = "claude-desktop";
  readonly name = "Claude Desktop";
  readonly nativeSupport = true;
  readonly configPath = "claude_desktop_config.json";
  override readonly scope = "user-only" as const;

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    const mcpServers: Record<string, unknown> = {};

    for (const server of servers) {
      if (server.transport.type !== "stdio") {
        throw new Error(
          "Claude Desktop local configuration currently supports stdio MCP servers only.",
        );
      }

      mcpServers[server.id] = {
        type: "stdio",
        command: server.transport.command,
        args: server.transport.args ?? [],
        env: server.transport.env ?? {},
      };
    }

    return [
      {
        path: this.configPath,
        content: JSON.stringify({ mcpServers }, null, 2) + "\n",
        format: "json",
      },
    ];
  }

  async detect(cwd?: string): Promise<boolean> {
    const configPath = resolveClaudeDesktopConfigPath(cwd);
    return configPath ? existsSync(configPath) : false;
  }

  async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const targetPath = resolveClaudeDesktopConfigPath(cwd);
    if (!targetPath) {
      throw new Error(
        "Claude Desktop is only supported on macOS and Windows for global installation.",
      );
    }

    const file = files[0];
    if (!file) return;

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, "utf-8");
  }

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const configPath = resolveClaudeDesktopConfigPath(cwd);
    if (!configPath || !existsSync(configPath)) return [];

    const raw = await readFile(configPath, "utf-8");
    const data = JSON.parse(raw) as { mcpServers?: Record<string, Record<string, unknown>> };
    const servers: MCPServerDefinition[] = [];

    for (const [id, config] of Object.entries(data.mcpServers ?? {})) {
      if (!config.command) continue;

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
    }

    return servers;
  }
}

const adapter = new ClaudeDesktopMCPAdapter();
registry.register(adapter);

export { ClaudeDesktopMCPAdapter, resolveClaudeDesktopConfigPath };
export default adapter;
