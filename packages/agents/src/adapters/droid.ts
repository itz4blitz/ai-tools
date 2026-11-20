import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { BaseAgentAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { AgentDefinition, GeneratedFile } from "../types/index.js";

class DroidAgentAdapter extends BaseAgentAdapter {
  readonly id = "droid";
  readonly name = "Factory Droid";
  readonly nativeSupport = true;
  readonly configDir = ".factory/droids";
  override readonly command = "droid";

  async generate(agents: AgentDefinition[]): Promise<GeneratedFile[]> {
    return agents.map((agent) => ({
      path: `${this.configDir}/${agent.id}.md`,
      content: formatDroidAgent(agent),
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
      agents.push(parseDroidAgent(id, content));
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

function formatDroidAgent(agent: AgentDefinition): string {
  const lines = ["---", `name: ${agent.name}`];
  if (agent.description) lines.push(`description: ${agent.description}`);
  if (agent.tools?.length) {
    lines.push("tools:");
    for (const tool of agent.tools) {
      lines.push(`  - ${tool}`);
    }
  }
  if (agent.model) lines.push(`model: ${agent.model}`);
  lines.push("---", "", `# ${agent.name}`, "", agent.instructions);
  return `${lines.join("\n")}\n`;
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseDroidAgent(id: string, raw: string): AgentDefinition {
  const normalized = raw.replace(/\r\n/g, "\n");
  const agent: AgentDefinition = { id, name: id, instructions: "" };
  let hasFrontmatterName = false;
  let body = normalized;

  const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized.trimStart());
  if (fmMatch) {
    const fm = fmMatch[1] ?? "";
    body = (fmMatch[2] ?? "").trim();

    let currentKey = "";
    let currentArray: string[] = [];

    for (const line of fm.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") && currentKey === "tools") {
        currentArray.push(unquoteYaml(trimmed.slice(2)));
        continue;
      }

      if (currentKey === "tools" && currentArray.length > 0) {
        agent.tools = currentArray;
        currentArray = [];
      }

      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      currentKey = line.slice(0, colonIdx).trim();
      const rawValue = line.slice(colonIdx + 1).trim();
      if (!rawValue) continue;

      if (currentKey === "name") {
        agent.name = unquoteYaml(rawValue);
        hasFrontmatterName = true;
      } else if (currentKey === "description") {
        agent.description = unquoteYaml(rawValue);
      } else if (currentKey === "model") {
        agent.model = unquoteYaml(rawValue);
      } else if (currentKey === "tools" && rawValue.startsWith("[") && rawValue.endsWith("]")) {
        const items = rawValue
          .slice(1, -1)
          .split(",")
          .map((item) => unquoteYaml(item))
          .filter((item) => item.length > 0);
        if (items.length > 0) agent.tools = items;
      }
    }

    if (currentKey === "tools" && currentArray.length > 0) {
      agent.tools = currentArray;
    }
  }

  const bodyLines = body.trim().split("\n");
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

const adapter = new DroidAgentAdapter();
registry.register(adapter);

export { DroidAgentAdapter };
export default adapter;
