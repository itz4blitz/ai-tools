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

class CursorMCPAdapter extends BaseMCPAdapter {
  readonly id = "cursor";
  readonly name = "Cursor";
  readonly nativeSupport = true;
  readonly configPath = ".cursor/mcp.json";
  readonly userConfigPath = join(homedir(), ".cursor", "mcp.json");
  readonly command = "cursor";

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
    return this.readMcpServers(resolve(dir, this.configPath));
  }

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configPath))) return true;
    if (existsSync(this.userConfigPath)) return true;
    if (this.command) return this.commandExists(this.command);
    return false;
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

  override async uninstall(cwd?: string, serverIds?: string[]): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, this.configPath);
    if (!existsSync(fullPath)) return;

    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await readFile(fullPath, "utf-8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      data = parsed as Record<string, unknown>;
    } catch {
      return;
    }

    const currentServers =
      data.mcpServers !== null &&
      typeof data.mcpServers === "object" &&
      !Array.isArray(data.mcpServers)
        ? { ...(data.mcpServers as McpServersMap) }
        : {};

    if (serverIds !== undefined) {
      for (const id of serverIds) {
        delete currentServers[id];
      }
    } else {
      for (const id of Object.keys(currentServers)) {
        delete currentServers[id];
      }
    }

    const extraTopLevelKeys = Object.keys(data).filter((key) => key !== "mcpServers");

    if (Object.keys(currentServers).length === 0 && extraTopLevelKeys.length === 0) {
      await rm(fullPath);
      return;
    }

    const updated: Record<string, unknown> = { ...data };
    if (Object.keys(currentServers).length > 0) {
      updated.mcpServers = currentServers;
    } else {
      delete updated.mcpServers;
    }
    await writeFile(fullPath, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
  }

  private async readMcpServers(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    const data = JSON.parse(await readFile(fullPath, "utf-8")) as { mcpServers?: McpServersMap };
    return fromMcpServersMap(data.mcpServers ?? {});
  }
}

const adapter = new CursorMCPAdapter();
registry.register(adapter);

export { CursorMCPAdapter };
export default adapter;
