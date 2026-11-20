import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BaseAgentAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { AgentDefinition, GeneratedFile } from "../types/index.js";

export class GrokAgentAdapter extends BaseAgentAdapter {
  readonly id = "grok";
  readonly name = "Grok";
  readonly nativeSupport = true;
  readonly configDir = ".grok/agents";
  readonly userConfigDir = ".grok/agents";
  override readonly command = "grok";

  get userAgentsDir(): string {
    return join(homedir(), ".grok", "agents");
  }

  async generate(agents: AgentDefinition[]): Promise<GeneratedFile[]> {
    return agents.map((agent) => ({
      path: `${this.configDir}/${agent.id}.md`,
      content: formatGrokAgent(agent),
      format: "md" as const,
    }));
  }

  async import(cwd?: string): Promise<AgentDefinition[]> {
    const dir = cwd ?? process.cwd();
    return this.importFromDir(resolve(dir, this.configDir));
  }

  async importUser(): Promise<AgentDefinition[]> {
    return this.importFromDir(this.userAgentsDir);
  }

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configDir))) return true;
    if (existsSync(this.userAgentsDir)) return true;
    if (this.command) return this.commandExists(this.command);
    return false;
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const agentsDir = resolve(dir, this.configDir);
    if (existsSync(agentsDir)) {
      await rm(agentsDir, { recursive: true, force: true });
    }
  }

  private async importFromDir(agentsDir: string): Promise<AgentDefinition[]> {
    if (!existsSync(agentsDir)) return [];

    const files = (await readdir(agentsDir)).toSorted();
    const agents: AgentDefinition[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const content = await readFile(resolve(agentsDir, file), "utf-8");
      const id = basename(file, ".md");
      agents.push(parseGrokAgent(id, content));
    }

    return agents;
  }
}

function formatGrokAgent(agent: AgentDefinition): string {
  const frontmatter: Record<string, unknown> = {};
  if (agent.description) frontmatter.description = agent.description;
  if (agent.tools?.length) frontmatter.tools = agent.tools;
  if (agent.model) frontmatter.model = agent.model;

  let md = "---\n";
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      md += `${key}:\n`;
      for (const item of value) {
        md += `  - ${item}\n`;
      }
    } else {
      md += `${key}: ${value}\n`;
    }
  }
  md += "---\n\n";
  md += `# ${agent.name}\n\n`;
  md += `${agent.instructions}\n`;
  return md;
}

function parseGrokAgent(id: string, raw: string): AgentDefinition {
  const agent: AgentDefinition = { id, name: id, instructions: "" };
  const trimmed = raw.trim();
  const match = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n([\s\S]*))?$/.exec(trimmed);

  const body = match ? (match[2] ?? "").trim() : trimmed;

  if (match) {
    const fm = match[1] ?? "";
    const lines = fm.split(/\r?\n/);
    let currentKey = "";
    let currentArray: string[] = [];

    for (const line of lines) {
      if (line.startsWith("  - ")) {
        currentArray.push(line.slice(4).trim());
      } else {
        if (currentKey && currentArray.length > 0) {
          if (currentKey === "tools") agent.tools = currentArray;
          currentArray = [];
        }
        const colonIdx = line.indexOf(":");
        if (colonIdx !== -1) {
          currentKey = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          if (value) {
            if (currentKey === "description") agent.description = value;
            if (currentKey === "model") agent.model = value;
          }
        }
      }
    }
    if (currentKey === "tools" && currentArray.length > 0) {
      agent.tools = currentArray;
    }
  }

  const bodyLines = body.split(/\r?\n/);
  let contentStart = 0;
  if (bodyLines[0]?.startsWith("# ")) {
    agent.name = bodyLines[0].slice(2).trim();
    contentStart = 1;
    if (bodyLines[contentStart]?.trim() === "") contentStart++;
  }
  agent.instructions = bodyLines.slice(contentStart).join("\n").trim();

  return agent;
}

const adapter = new GrokAgentAdapter();
registry.register(adapter);
export default adapter;
