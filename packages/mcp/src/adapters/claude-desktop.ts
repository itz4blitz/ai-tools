import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { BaseMCPAdapter } from "./base.js";
import { fromMcpServersMap, mergeMcpServersJson, type McpServersMap } from "./mcp-servers-json.js";
import { registry } from "./registry.js";
import type { GeneratedFile, MCPServerDefinition } from "../types/index.js";

function resolveClaudeDesktopConfigPath(): string | null {
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
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }

  if (process.platform === "linux") {
    const xdgConfigHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(xdgConfigHome, "Claude", "claude_desktop_config.json");
  }

  return null;
}

class ClaudeDesktopMCPAdapter extends BaseMCPAdapter {
  readonly id = "claude-desktop";
  readonly name = "Claude Desktop";
  readonly nativeSupport = true;
  readonly configPath = "claude_desktop_config.json";
  readonly userConfigPath = resolveClaudeDesktopConfigPath() ?? undefined;
  readonly scope = "user-only" as const;

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
        content: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
        format: "json",
      },
    ];
  }

  override async detect(): Promise<boolean> {
    const configPath = resolveClaudeDesktopConfigPath();
    return configPath ? existsSync(configPath) : false;
  }

  override async install(files: GeneratedFile[]): Promise<void> {
    const targetPath = resolveClaudeDesktopConfigPath();
    if (!targetPath) {
      throw new Error(
        "Claude Desktop is only supported on macOS, Windows, and Linux for global installation.",
      );
    }

    const file = files[0];
    if (!file) return;

    await mkdir(dirname(targetPath), { recursive: true });
    let content = file.content;
    if (existsSync(targetPath)) {
      content = mergeMcpServersJson(await readFile(targetPath, "utf-8"), file.content);
    }
    await writeFile(targetPath, content, "utf-8");
  }

  override async uninstall(): Promise<void> {
    const targetPath = resolveClaudeDesktopConfigPath();
    if (!targetPath || !existsSync(targetPath)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(targetPath, "utf-8"));
    } catch {
      return;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const data = parsed as Record<string, unknown>;
    if (!("mcpServers" in data)) return;

    const rest = { ...data };
    delete rest.mcpServers;
    await writeFile(targetPath, `${JSON.stringify(rest, null, 2)}\n`, "utf-8");
  }

  async import(): Promise<MCPServerDefinition[]> {
    const configPath = resolveClaudeDesktopConfigPath();
    if (!configPath || !existsSync(configPath)) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(configPath, "utf-8"));
    } catch {
      return [];
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }

    const mcpServers = (parsed as Record<string, unknown>).mcpServers;
    if (mcpServers === null || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
      return [];
    }

    const validEntries: McpServersMap = {};
    for (const [id, value] of Object.entries(mcpServers as Record<string, unknown>)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        validEntries[id] = value as Record<string, unknown>;
      }
    }

    return fromMcpServersMap(validEntries).filter((server) => server.transport.type === "stdio");
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    return this.import();
  }
}

const adapter = new ClaudeDesktopMCPAdapter();
registry.register(adapter);

export { ClaudeDesktopMCPAdapter, resolveClaudeDesktopConfigPath };
export default adapter;
