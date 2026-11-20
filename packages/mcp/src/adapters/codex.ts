import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, MCPServerDefinition } from "../types/index.js";
import { encodeMcpToml, mergeMcpToml, parseMcpToml, stripMcpTomlTables } from "../toml-mcp.js";

class CodexMCPAdapter extends BaseMCPAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  readonly nativeSupport = true;
  readonly configPath = ".codex/config.toml";
  readonly userConfigPath = join(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
    "config.toml",
  );
  readonly command = "codex";

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    return [
      {
        path: this.configPath,
        content: encodeMcpToml(servers, { headerTable: "http_headers" }),
        format: "toml",
      },
    ];
  }

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, this.configPath);
    if (!existsSync(fullPath)) return [];
    return parseMcpToml(await readFile(fullPath, "utf-8"));
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    if (!existsSync(this.userConfigPath)) return [];
    return parseMcpToml(await readFile(this.userConfigPath, "utf-8"));
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = isAbsolute(file.path) ? file.path : resolve(dir, file.path);
      const managedIds = parseMcpToml(file.content).map((server) => server.id);
      let content = file.content;
      if (existsSync(fullPath)) {
        content = mergeMcpToml(
          await readFile(fullPath, "utf-8"),
          parseMcpToml(file.content),
          managedIds,
          { headerTable: "http_headers" },
        );
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
      return;
    }

    await writeFile(fullPath, `${remaining}\n`, "utf-8");
  }
}

const adapter = new CodexMCPAdapter();
registry.register(adapter);

export { CodexMCPAdapter };
export default adapter;
