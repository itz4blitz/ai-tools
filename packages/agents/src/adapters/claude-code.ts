import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { BaseAgentAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { AgentDefinition, GeneratedFile } from "../types/index.js";

class ClaudeCodeAgentAdapter extends BaseAgentAdapter {
  readonly id = "claude-code";
  readonly name = "Claude Code";
  readonly nativeSupport = true;
  readonly configDir = ".claude/agents";
  override readonly command = "claude";

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

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const agentsDir = resolve(dir, this.configDir);
    if (existsSync(agentsDir)) {
      await rm(agentsDir, { recursive: true, force: true });
    }
  }
}

function formatYamlValue(value: string): string {
  if (value === "" || /^[\s]|[\s]$/.test(value) || /[:#"'[\]{}*&!|>%@`\n]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function unquoteYaml(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseInlineTools(raw: string): string[] {
  const inner = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return inner
    .split(",")
    .map((item) => unquoteYaml(item.trim()))
    .filter((item) => item.length > 0);
}

function formatAgent(agent: AgentDefinition): string {
  const description = agent.description ?? agent.name;

  let md = "---\n";
  md += `name: ${formatYamlValue(agent.name)}\n`;
  md += `description: ${formatYamlValue(description)}\n`;
  if (agent.tools?.length) {
    md += "tools:\n";
    for (const item of agent.tools) {
      md += `  - ${formatYamlValue(item)}\n`;
    }
  }
  if (agent.model) {
    md += `model: ${formatYamlValue(agent.model)}\n`;
  }
  md += "---\n\n";
  md += `# ${agent.name}\n\n`;
  md += agent.instructions + "\n";
  return md;
}

function parseBody(body: string, agent: AgentDefinition): void {
  const bodyLines = body.split("\n");
  let contentStart = 0;
  if (bodyLines[0]?.startsWith("# ")) {
    const heading = bodyLines[0].slice(2).trim();
    if (heading && agent.name === agent.id) {
      agent.name = heading;
    }
    contentStart = 1;
    if (bodyLines[contentStart]?.trim() === "") contentStart++;
  }
  agent.instructions = bodyLines.slice(contentStart).join("\n").trim();
}

function parseAgent(id: string, raw: string): AgentDefinition {
  const normalized = raw.replace(/\r\n/g, "\n");
  const agent: AgentDefinition = { id, name: id, instructions: "" };

  const match = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(normalized);
  if (match) {
    const fm = (match[1] ?? "").trim();
    const body = (match[2] ?? "").trim();

    let currentKey = "";
    const tools: string[] = [];

    for (const line of fm.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("- ")) {
        if (currentKey === "tools") {
          const item = unquoteYaml(trimmed.slice(2).trim());
          if (item) tools.push(item);
        }
        continue;
      }

      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      currentKey = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (!value) continue;

      if (currentKey === "name") {
        agent.name = unquoteYaml(value);
      } else if (currentKey === "description") {
        agent.description = unquoteYaml(value);
      } else if (currentKey === "model") {
        agent.model = unquoteYaml(value);
      } else if (currentKey === "tools") {
        tools.push(...parseInlineTools(value));
      }
    }

    if (tools.length > 0) {
      agent.tools = tools;
    }

    parseBody(body, agent);
    return agent;
  }

  parseBody(normalized.trim(), agent);
  return agent;
}

const adapter = new ClaudeCodeAgentAdapter();
registry.register(adapter);

export { ClaudeCodeAgentAdapter };
export default adapter;
