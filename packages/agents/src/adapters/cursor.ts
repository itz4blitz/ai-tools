import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BaseAgentAdapter, registry } from "./index.js";
import type { AgentDefinition, GeneratedFile } from "../types/index.js";

export type CursorAgentLayer = "project" | "user";

export type CursorAgentDefinition = AgentDefinition & {
  readonly?: boolean;
  isBackground?: boolean;
};

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function formatCursorAgent(agent: CursorAgentDefinition): string {
  let md = "---\n";
  md += `name: ${agent.name}\n`;
  if (agent.description) md += `description: ${agent.description}\n`;
  if (agent.model) md += `model: ${agent.model}\n`;
  if (typeof agent.readonly === "boolean") md += `readonly: ${agent.readonly}\n`;
  if (typeof agent.isBackground === "boolean") md += `is_background: ${agent.isBackground}\n`;
  if (agent.tools?.length) {
    md += "tools:\n";
    for (const tool of agent.tools) {
      md += `  - ${tool}\n`;
    }
  }
  md += "---\n\n";
  md += `# ${agent.name}\n\n`;
  md += agent.instructions + "\n";
  return md;
}

function parseCursorAgent(id: string, raw: string): CursorAgentDefinition {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const agent: CursorAgentDefinition = { id, name: id, instructions: "" };

  let body = normalized;
  let hasFrontmatterName = false;

  const fmMatch = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(normalized);
  if (fmMatch) {
    const fm = (fmMatch[1] ?? "").trim();
    body = (fmMatch[2] ?? "").trim();

    const lines = fm.split("\n");
    let currentKey = "";
    let currentArray: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        if (currentKey === "tools") {
          currentArray.push(unquote(trimmed.slice(2)));
        }
        continue;
      }

      if (currentKey === "tools" && currentArray.length > 0) {
        agent.tools = currentArray;
      }
      currentArray = [];

      const colonIdx = line.indexOf(":");
      if (colonIdx !== -1) {
        currentKey = line.slice(0, colonIdx).trim();
        const value = unquote(line.slice(colonIdx + 1));
        if (value) {
          switch (currentKey) {
            case "name":
              agent.name = value;
              hasFrontmatterName = true;
              break;
            case "description":
              agent.description = value;
              break;
            case "model":
              agent.model = value;
              break;
            case "readonly":
              if (value === "true" || value === "false") {
                agent.readonly = value === "true";
              }
              break;
            case "is_background":
            case "isBackground":
              if (value === "true" || value === "false") {
                agent.isBackground = value === "true";
              }
              break;
          }
        }
      }
    }

    if (currentKey === "tools" && currentArray.length > 0) {
      agent.tools = currentArray;
    }
  }

  const bodyLines = body.split("\n");
  let contentStart = 0;
  if (bodyLines[0]?.startsWith("# ")) {
    if (!hasFrontmatterName) {
      agent.name = bodyLines[0].slice(2).trim();
    }
    contentStart = 1;
    if (bodyLines[contentStart]?.trim() === "") contentStart++;
  }
  agent.instructions = bodyLines.slice(contentStart).join("\n").trim();

  return agent;
}

class CursorAgentAdapter extends BaseAgentAdapter {
  readonly id = "cursor";
  readonly name = "Cursor";
  readonly nativeSupport = true;
  readonly configDir = ".cursor/agents";
  readonly userConfigDir = ".cursor/agents";
  override readonly command = "cursor";

  async generate(
    agents: CursorAgentDefinition[],
    layer: CursorAgentLayer = "project",
  ): Promise<GeneratedFile[]> {
    return agents.map((agent) => ({
      path:
        layer === "user"
          ? join(homedir(), ".cursor", "agents", `${agent.id}.md`)
          : `${this.configDir}/${agent.id}.md`,
      content: formatCursorAgent(agent),
      format: "md" as const,
    }));
  }

  async import(cwd?: string): Promise<CursorAgentDefinition[]> {
    const dir = cwd ?? process.cwd();
    return this.importFromDir(resolve(dir, this.configDir));
  }

  async importUser(): Promise<CursorAgentDefinition[]> {
    return this.importFromDir(join(homedir(), ".cursor", "agents"));
  }

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configDir))) return true;
    if (existsSync(join(homedir(), ".cursor", "agents"))) return true;
    return super.detect(cwd);
  }

  override async uninstall(cwd?: string, layer: CursorAgentLayer = "project"): Promise<void> {
    const agentsDir =
      layer === "user"
        ? join(homedir(), ".cursor", "agents")
        : resolve(cwd ?? process.cwd(), this.configDir);
    if (!existsSync(agentsDir)) return;
    await rm(agentsDir, { recursive: true, force: true });
  }

  private async importFromDir(agentsDir: string): Promise<CursorAgentDefinition[]> {
    if (!existsSync(agentsDir)) return [];

    const files = await readdir(agentsDir);
    const agents: CursorAgentDefinition[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const content = await readFile(resolve(agentsDir, file), "utf-8");
      const id = basename(file, ".md");
      agents.push(parseCursorAgent(id, content));
    }

    return agents;
  }
}

const adapter = new CursorAgentAdapter();
registry.register(adapter);

export { CursorAgentAdapter };
export default adapter;
