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

class ContinueMCPAdapter extends BaseMCPAdapter {
  readonly id = "continue";
  readonly name = "Continue";
  readonly nativeSupport = true;
  readonly configPath = ".continue/mcpServers/mcp.json";
  readonly userConfigPath = join(homedir(), ".continue", "mcpServers", "mcp.json");
  readonly command = "cn";

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (
      existsSync(resolve(dir, this.configPath)) ||
      existsSync(resolve(dir, ".continue/mcpServers")) ||
      existsSync(resolve(dir, ".continue/config.yaml"))
    ) {
      return true;
    }
    return this.commandExists(this.command);
  }

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
        content = mergeMcpServersJson(await readFile(fullPath, "utf-8"), file.content);
      }
      await writeFile(fullPath, content, "utf-8");
    }
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, this.configPath);
    if (!existsSync(fullPath)) return;

    try {
      const parsed: unknown = JSON.parse(await readFile(fullPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = { ...(parsed as Record<string, unknown>) };
        delete record.mcpServers;
        if (Object.keys(record).length > 0) {
          await writeFile(fullPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
          return;
        }
      }
    } catch {
      // Fall through to remove file if unparseable
    }

    await rm(fullPath, { force: true });
  }

  private async readMcpServers(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    try {
      const data = JSON.parse(await readFile(fullPath, "utf-8")) as {
        mcpServers?: McpServersMap;
      };
      if (!data || typeof data !== "object" || Array.isArray(data)) return [];
      return fromMcpServersMap(data.mcpServers ?? {});
    } catch {
      return [];
    }
  }
}

const adapter = new ContinueMCPAdapter();
registry.register(adapter);

export { ContinueMCPAdapter };
export default adapter;
