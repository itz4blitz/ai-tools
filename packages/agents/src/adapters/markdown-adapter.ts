import { BaseAgentAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { AgentDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";

export type MarkdownAdapterConfig = {
  id: string;
  name: string;
  configDir: string;
  command?: string;
};

export function createMarkdownAdapter(config: MarkdownAdapterConfig) {
  class MarkdownAgentAdapter extends BaseAgentAdapter {
    readonly id = config.id;
    readonly name = config.name;
    readonly nativeSupport = true;
    readonly configDir = config.configDir;
    override readonly command = config.command;

    async generate(agents: AgentDefinition[]): Promise<GeneratedFile[]> {
      return agents.map((agent) => ({
        path: `${this.configDir}/${agent.id}.md`,
        content: formatAgent(agent),
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
        agents.push(parseAgent(id, content));
      }

      return agents;
    }
  }

  const adapter = new MarkdownAgentAdapter();
  registry.register(adapter);
  return {
    Adapter: MarkdownAgentAdapter as unknown as typeof BaseAgentAdapter,
    adapter: adapter as BaseAgentAdapter,
  };
}

function formatAgent(agent: AgentDefinition): string {
  const frontmatter: Record<string, unknown> = {};
  if (agent.name) frontmatter.name = agent.name;
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
  md += agent.instructions + "\n";
  return md;
}

function parseInlineTools(value: string): string[] {
  const stripped = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return stripped
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter((item) => item.length > 0);
}

function parseAgent(id: string, raw: string): AgentDefinition {
  const normalized = raw.replace(/\r\n/g, "\n");
  const agent: AgentDefinition = { id, name: id, instructions: "" };
  let hasFrontmatterName = false;

  if (normalized.startsWith("---")) {
    const endIdx = normalized.indexOf("---", 3);
    if (endIdx !== -1) {
      const fm = normalized.slice(3, endIdx).trim();
      const body = normalized.slice(endIdx + 3).trim();

      // Simple YAML-like parsing
      const lines = fm.split(/\r?\n/);
      let currentKey = "";
      let currentArray: string[] = [];

      for (const line of lines) {
        const listMatch = /^\s+-\s+(.*)$/.exec(line);
        if (listMatch) {
          const item = listMatch[1]?.trim();
          if (item) currentArray.push(item);
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
              if (currentKey === "name") {
                agent.name = value;
                hasFrontmatterName = true;
              } else if (currentKey === "description") {
                agent.description = value;
              } else if (currentKey === "model") {
                agent.model = value;
              } else if (currentKey === "tools") {
                const parsedTools = parseInlineTools(value);
                if (parsedTools.length > 0) agent.tools = parsedTools;
              }
            }
          }
        }
      }
      if (currentKey === "tools" && currentArray.length > 0) {
        agent.tools = currentArray;
      }

      // Parse body
      const bodyLines = body.split(/\r?\n/);
      let contentStart = 0;
      if (bodyLines[0]?.startsWith("# ")) {
        if (!hasFrontmatterName) {
          agent.name = bodyLines[0].slice(2).trim();
        }
        contentStart = 1;
        if (bodyLines[contentStart]?.trim() === "") contentStart++;
      }
      agent.instructions = bodyLines.slice(contentStart).join("\n").trim();
    }
  } else {
    // No frontmatter, try to parse just body
    const bodyLines = normalized.split(/\r?\n/);
    let contentStart = 0;
    if (bodyLines[0]?.startsWith("# ")) {
      agent.name = bodyLines[0].slice(2).trim();
      contentStart = 1;
      if (bodyLines[contentStart]?.trim() === "") contentStart++;
    }
    agent.instructions = bodyLines.slice(contentStart).join("\n").trim();
  }

  return agent;
}
