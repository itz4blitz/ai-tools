import { BaseAgentAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { AgentDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

class GeminiCliAgentAdapter extends BaseAgentAdapter {
  readonly id = "gemini-cli";
  readonly name = "Gemini CLI";
  readonly nativeSupport = true;
  readonly configDir = ".gemini/agents";
  override readonly command = "gemini";

  async generate(agents: AgentDefinition[]): Promise<GeneratedFile[]> {
    return agents.map((agent) => ({
      path: `${this.configDir}/${agent.id}.md`,
      content: formatGeminiAgent(agent),
      format: "md" as const,
    }));
  }

  async import(cwd?: string): Promise<AgentDefinition[]> {
    const dir = cwd ?? process.cwd();
    const agentsDir = resolve(dir, this.configDir);
    if (!existsSync(agentsDir)) return [];

    const files = await readdir(agentsDir);
    const agents: AgentDefinition[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const content = await readFile(resolve(agentsDir, file), "utf-8");
      const id = basename(file, ".md");
      agents.push(parseGeminiAgent(id, content));
    }

    return agents;
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const agentsDir = resolve(dir, this.configDir);
    if (existsSync(agentsDir)) {
      await rm(agentsDir, { recursive: true, force: true });
    }
  }
}

function formatGeminiAgent(agent: AgentDefinition): string {
  const description = agent.description ?? agent.name;
  let md = "---\n";
  md += `name: ${agent.id}\n`;
  md += `description: ${description}\n`;
  if (agent.tools?.length) {
    md += "tools:\n";
    for (const tool of agent.tools) {
      md += `  - ${tool}\n`;
    }
  }
  if (agent.model) {
    md += `model: ${agent.model}\n`;
  }
  md += "---\n\n";
  md += `# ${agent.name}\n\n`;
  md += `${agent.instructions}\n`;
  return md;
}

function parseGeminiAgent(id: string, raw: string): AgentDefinition {
  const normalized = raw.replace(/\r\n/g, "\n");
  const agent: AgentDefinition = { id, name: id, instructions: "" };

  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized.trim());
  const body = match ? (match[2] ?? "").trim() : normalized.trim();

  if (match) {
    const fm = match[1] ?? "";
    const lines = fm.split("\n");
    let currentKey = "";
    let currentArray: string[] = [];

    for (const line of lines) {
      if (line.startsWith("  - ")) {
        currentArray.push(line.slice(4).trim());
      } else {
        if (currentKey === "tools" && currentArray.length > 0) {
          agent.tools = currentArray;
          currentArray = [];
        }
        const colonIdx = line.indexOf(":");
        if (colonIdx !== -1) {
          currentKey = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          if (value) {
            if (currentKey === "name") agent.name = value;
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

  const bodyLines = body.split("\n");
  let contentStart = 0;
  if (bodyLines[0]?.startsWith("# ")) {
    agent.name = bodyLines[0].slice(2).trim() || agent.name;
    contentStart = 1;
    if (bodyLines[contentStart]?.trim() === "") contentStart++;
  }
  agent.instructions = bodyLines.slice(contentStart).join("\n").trim();

  return agent;
}

const adapter = new GeminiCliAgentAdapter();
registry.register(adapter);

export { GeminiCliAgentAdapter };
export default adapter;
