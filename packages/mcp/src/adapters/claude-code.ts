import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, MCPServerDefinition } from "../types/index.js";
import {
  encodeMcpServersFile,
  fromMcpServersMap,
  mergeMcpServersJson,
  type McpServersMap,
} from "./mcp-servers-json.js";

type ClaudeUserJson = {
  mcpServers?: McpServersMap;
  projects?: Record<string, { mcpServers?: McpServersMap }>;
};

class ClaudeCodeMCPAdapter extends BaseMCPAdapter {
  readonly id = "claude-code";
  readonly name = "Claude Code";
  readonly nativeSupport = true;
  readonly configPath = ".mcp.json";
  readonly userConfigPath = join(homedir(), ".claude.json");
  readonly command = "claude";

  private readonly managedServersByFile = new Map<string, Set<string>>();

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    return [
      {
        path: this.configPath,
        content: encodeMcpServersFile(servers),
        format: "json",
      },
    ];
  }

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const dir = cwd ?? process.cwd();
    const projectServers = await this.readMcpServers(resolve(dir, this.configPath));
    const localProjectServers = await this.readProjectMcpServersFromUserConfig(dir);

    if (localProjectServers.length === 0) return projectServers;

    const merged = new Map<string, MCPServerDefinition>();
    for (const server of projectServers) {
      merged.set(server.id, server);
    }
    for (const server of localProjectServers) {
      merged.set(server.id, server);
    }
    return [...merged.values()];
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    return this.readMcpServers(this.userConfigPath);
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

      const managed = this.managedServersByFile.get(fullPath) ?? new Set<string>();
      for (const id of extractServerIds(file.content)) {
        managed.add(id);
      }
      this.managedServersByFile.set(fullPath, managed);
    }
  }

  override async uninstall(cwd?: string, managedIds?: string[]): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, this.configPath);
    if (!existsSync(fullPath)) return;

    const idsToRemove = managedIds ? new Set(managedIds) : this.managedServersByFile.get(fullPath);

    if (!idsToRemove || idsToRemove.size === 0) return;

    const raw = await readFile(fullPath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const current =
      data.mcpServers !== null &&
      typeof data.mcpServers === "object" &&
      !Array.isArray(data.mcpServers)
        ? { ...(data.mcpServers as McpServersMap) }
        : {};

    for (const id of idsToRemove) {
      delete current[id];
    }

    const tracked = this.managedServersByFile.get(fullPath);
    if (tracked) {
      for (const id of idsToRemove) {
        tracked.delete(id);
      }
      if (tracked.size === 0) {
        this.managedServersByFile.delete(fullPath);
      }
    }

    const remainingOtherKeys = Object.keys(data).filter((key) => key !== "mcpServers");
    if (Object.keys(current).length === 0 && remainingOtherKeys.length === 0) {
      await rm(fullPath);
      return;
    }

    data.mcpServers = current;
    await writeFile(fullPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  }

  private async readMcpServers(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    const data = JSON.parse(await readFile(fullPath, "utf-8")) as ClaudeUserJson;
    return fromMcpServersMap(data.mcpServers ?? {});
  }

  private async readProjectMcpServersFromUserConfig(cwd: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(this.userConfigPath)) return [];
    try {
      const data = JSON.parse(await readFile(this.userConfigPath, "utf-8")) as ClaudeUserJson;
      const projects = data.projects;
      if (!projects || typeof projects !== "object" || Array.isArray(projects)) return [];

      const resolvedCwd = resolve(cwd);
      const entry =
        projects[resolvedCwd] ??
        projects[cwd] ??
        Object.entries(projects).find(([key]) => resolve(key) === resolvedCwd)?.[1];

      return fromMcpServersMap(entry?.mcpServers ?? {});
    } catch {
      return [];
    }
  }
}

function extractServerIds(rawJson: string): string[] {
  try {
    const parsed = JSON.parse(rawJson) as { mcpServers?: McpServersMap };
    if (
      parsed.mcpServers &&
      typeof parsed.mcpServers === "object" &&
      !Array.isArray(parsed.mcpServers)
    ) {
      return Object.keys(parsed.mcpServers);
    }
  } catch {
    // Ignore invalid JSON
  }
  return [];
}

const adapter = new ClaudeCodeMCPAdapter();
registry.register(adapter);

export { ClaudeCodeMCPAdapter };
export default adapter;
