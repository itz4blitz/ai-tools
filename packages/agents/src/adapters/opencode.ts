import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { BaseAgentAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { AgentDefinition, GeneratedFile } from "../types/index.js";

const LEGACY_CONFIG_DIR = ".opencode/agent";

class OpenCodeAgentAdapter extends BaseAgentAdapter {
  readonly id = "opencode";
  readonly name = "OpenCode";
  readonly nativeSupport = true;
  readonly configDir = ".opencode/agents";
  override readonly command = "opencode";

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (
      existsSync(resolve(dir, this.configDir)) ||
      existsSync(resolve(dir, LEGACY_CONFIG_DIR)) ||
      existsSync(resolve(dir, "opencode.json")) ||
      existsSync(resolve(dir, "opencode.jsonc"))
    ) {
      return true;
    }
    return this.commandExists(this.command);
  }

  async generate(agents: AgentDefinition[]): Promise<GeneratedFile[]> {
    return agents.map((agent) => ({
      path: `${this.configDir}/${agent.id}.md`,
      content: formatOpenCodeAgent(agent),
      format: "md" as const,
    }));
  }

  async import(cwd?: string): Promise<AgentDefinition[]> {
    const dir = cwd ?? process.cwd();
    const agents: AgentDefinition[] = [];
    const seen = new Set<string>();

    for (const relDir of [this.configDir, LEGACY_CONFIG_DIR]) {
      const agentsDir = resolve(dir, relDir);
      if (!existsSync(agentsDir)) continue;

      const files = await readdir(agentsDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const id = basename(file, ".md");
        if (seen.has(id)) continue;
        seen.add(id);
        const content = await readFile(resolve(agentsDir, file), "utf-8");
        agents.push(parseOpenCodeAgent(id, content));
      }
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

function formatOpenCodeAgent(agent: AgentDefinition): string {
  let md = "---\n";
  if (agent.description) {
    md += `description: ${agent.description}\n`;
  }
  md += "mode: subagent\n";
  if (agent.model) {
    md += `model: ${agent.model}\n`;
  }
  if (agent.tools && agent.tools.length > 0) {
    md += "tools:\n";
    for (const tool of agent.tools) {
      md += `  ${tool}: true\n`;
    }
  }
  md += "---\n\n";
  md += `# ${agent.name}\n\n`;
  md += `${agent.instructions}\n`;
  return md;
}

function parseOpenCodeAgent(id: string, raw: string): AgentDefinition {
  const agent: AgentDefinition = { id, name: id, instructions: "" };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/.exec(raw.trim());

  if (match) {
    const fm = match[1] ?? "";
    const body = (match[2] ?? "").trim();

    const lines = fm.split(/\r?\n/);
    let currentKey = "";
    const parsedTools: string[] = [];

    for (const line of lines) {
      // Indented YAML list item (`  - tool`) or boolean map entry (`  tool: true`)
      if (/^\s+-\s+/.test(line)) {
        if (currentKey === "tools") {
          const item = line.replace(/^\s+-\s+/, "").trim();
          if (item) parsedTools.push(item);
        }
        continue;
      }

      if (/^\s+/.test(line) && currentKey === "tools") {
        const colonIdx = line.indexOf(":");
        if (colonIdx !== -1) {
          const toolName = line.slice(0, colonIdx).trim();
          const boolVal = line
            .slice(colonIdx + 1)
            .trim()
            .toLowerCase();
          if (toolName && boolVal === "true") {
            parsedTools.push(toolName);
          }
        }
        continue;
      }

      const colonIdx = line.indexOf(":");
      if (colonIdx !== -1) {
        currentKey = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (value) {
          if (currentKey === "description") agent.description = value;
          if (currentKey === "model") agent.model = value;
          // `mode` (primary | subagent | all) is recognized OpenCode frontmatter
        }
      }
    }

    if (parsedTools.length > 0) {
      agent.tools = parsedTools;
    }

    parseAgentBody(agent, body);
  } else {
    parseAgentBody(agent, raw.trim());
  }

  return agent;
}

function parseAgentBody(agent: AgentDefinition, body: string): void {
  const bodyLines = body.split(/\r?\n/);
  let contentStart = 0;
  if (bodyLines[0]?.startsWith("# ")) {
    agent.name = bodyLines[0].slice(2).trim();
    contentStart = 1;
    if (bodyLines[contentStart]?.trim() === "") contentStart++;
  }
  agent.instructions = bodyLines.slice(contentStart).join("\n").trim();
}

const adapter = new OpenCodeAgentAdapter();
registry.register(adapter);

export { OpenCodeAgentAdapter };
export default adapter;
