import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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

class DroidMCPAdapter extends BaseMCPAdapter {
  readonly id = "droid";
  readonly name = "Factory Droid";
  readonly nativeSupport = true;
  readonly configPath = ".factory/mcp.json";
  override readonly userConfigPath = join(homedir(), ".factory", "mcp.json");
  override readonly command = "droid";

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
        try {
          content = mergeMcpServersJson(await readFile(fullPath, "utf-8"), file.content);
        } catch {
          content = file.content;
        }
      }
      await writeFile(fullPath, content, "utf-8");
    }
  }

  override async uninstall(cwd?: string, serverIds?: string[]): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, this.configPath);
    if (!existsSync(fullPath)) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(fullPath, "utf-8"));
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const data = parsed as Record<string, unknown>;
    const otherKeys = Object.keys(data).filter((key) => key !== "mcpServers");

    if (serverIds && serverIds.length > 0) {
      const current =
        data.mcpServers && typeof data.mcpServers === "object" && !Array.isArray(data.mcpServers)
          ? { ...(data.mcpServers as McpServersMap) }
          : {};
      for (const id of serverIds) {
        delete current[id];
      }
      if (Object.keys(current).length === 0 && otherKeys.length === 0) {
        await rm(fullPath);
        return;
      }
      if (Object.keys(current).length > 0) {
        data.mcpServers = current;
      } else {
        delete data.mcpServers;
      }
      await writeFile(fullPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
      return;
    }

    if (otherKeys.length > 0) {
      delete data.mcpServers;
      await writeFile(fullPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
      return;
    }

    await rm(fullPath);
  }

  private async readMcpServers(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    try {
      const data = JSON.parse(await readFile(fullPath, "utf-8")) as {
        mcpServers?: McpServersMap;
      };
      return fromMcpServersMap(data.mcpServers ?? {});
    } catch {
      return [];
    }
  }
}

const adapter = new DroidMCPAdapter();
registry.register(adapter);

export { DroidMCPAdapter };
export default adapter;
