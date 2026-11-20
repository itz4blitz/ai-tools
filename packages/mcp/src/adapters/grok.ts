import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, MCPServerDefinition } from "../types/index.js";
import { encodeMcpToml, mergeMcpToml, parseMcpToml, stripMcpTomlTables } from "../toml-mcp.js";

class GrokMCPAdapter extends BaseMCPAdapter {
  readonly id = "grok";
  readonly name = "Grok";
  readonly nativeSupport = true;
  readonly configPath = ".grok/config.toml";
  readonly userConfigPath = join(homedir(), ".grok", "config.toml");
  readonly command = "grok";

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    return [
      {
        path: this.configPath,
        content: encodeMcpToml(servers),
        format: "toml",
      },
    ];
  }

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const dir = cwd ?? process.cwd();
    return this.readToml(resolve(dir, this.configPath));
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    return this.readToml(this.userConfigPath);
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = isAbsolute(file.path) ? file.path : resolve(dir, file.path);
      const managedIds = parseMcpToml(file.content).map((server) => server.id);
      let content = file.content;
      if (existsSync(fullPath)) {
        const existing = await readFile(fullPath, "utf-8");
        content = mergeMcpToml(existing, parseMcpToml(file.content), managedIds);
      }
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content.endsWith("\n") ? content : `${content}\n`, "utf-8");
    }
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, this.configPath);
    if (!existsSync(fullPath)) return;

    const existing = await readFile(fullPath, "utf-8");
    const remaining = stripMcpTomlTables(existing);
    if (remaining.trim() === "") {
      await rm(fullPath);
    } else {
      await writeFile(fullPath, `${remaining}\n`, "utf-8");
    }
  }

  private async readToml(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    const raw = await readFile(fullPath, "utf-8");
    return parseMcpToml(raw);
  }
}

const adapter = new GrokMCPAdapter();
registry.register(adapter);

export { GrokMCPAdapter };
export default adapter;
