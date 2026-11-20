import { BaseAgentAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { AgentDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

const AGENT_SUFFIX = ".agent.md";

class CopilotAgentAdapter extends BaseAgentAdapter {
  readonly id = "copilot";
  readonly name = "Copilot";
  readonly nativeSupport = true;
  readonly configDir = ".github/agents";
  override readonly installStrategy = "transform" as const;
  override readonly command = "copilot";

  async generate(agents: AgentDefinition[]): Promise<GeneratedFile[]> {
    return agents.map((agent) => ({
      path: `${this.configDir}/${agent.id}${AGENT_SUFFIX}`,
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
      if (!file.endsWith(AGENT_SUFFIX)) continue;
      const content = await readFile(resolve(agentsDir, file), "utf-8");
      const id = basename(file, AGENT_SUFFIX);
      agents.push(parseAgent(id, content));
    }

    return agents;
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const agentsDir = resolve(dir, this.configDir);
    if (!existsSync(agentsDir)) return;

    const files = await readdir(agentsDir);
    for (const file of files) {
      if (!file.endsWith(AGENT_SUFFIX)) continue;
      await rm(resolve(agentsDir, file), { force: true });
    }

    const remaining = await readdir(agentsDir);
    if (remaining.length === 0) {
      await rm(agentsDir, { recursive: true, force: true });
    }
  }
}

function formatAgent(agent: AgentDefinition): string {
  const lines: string[] = ["---", `name: ${agent.name}`];
  if (agent.description) {
    lines.push(`description: ${agent.description}`);
  }
  if (agent.tools && agent.tools.length > 0) {
    lines.push("tools:");
    for (const tool of agent.tools) {
      lines.push(`  - ${tool}`);
    }
  }
  if (agent.model) {
    lines.push(`model: ${agent.model}`);
  }
  lines.push("---", "", agent.instructions);
  return `${lines.join("\n")}\n`;
}

function parseAgent(id: string, raw: string): AgentDefinition {
  const agent: AgentDefinition = { id, name: id, instructions: "" };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw.trim());

  if (!match) {
    return parseBodyOnly(id, raw);
  }

  const fm = match[1] ?? "";
  const body = (match[2] ?? "").trim();

  let currentKey = "";
  let currentArray: string[] = [];

  for (const line of fm.split(/\r?\n/)) {
    const listMatch = /^\s*-\s+(.+)$/.exec(line);
    if (listMatch) {
      const item = stripQuotes((listMatch[1] ?? "").trim());
      if (item) currentArray.push(item);
      continue;
    }

    if (currentKey === "tools" && currentArray.length > 0) {
      agent.tools = currentArray;
      currentArray = [];
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    currentKey = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();

    if (!value) continue;

    if (currentKey === "name") {
      agent.name = stripQuotes(value);
    } else if (currentKey === "description") {
      agent.description = stripQuotes(value);
    } else if (currentKey === "model") {
      agent.model = stripQuotes(value);
    } else if (currentKey === "tools" && value.startsWith("[") && value.endsWith("]")) {
      const items = value
        .slice(1, -1)
        .split(",")
        .map((item) => stripQuotes(item.trim()))
        .filter(Boolean);
      if (items.length > 0) agent.tools = items;
    }
  }

  if (currentKey === "tools" && currentArray.length > 0) {
    agent.tools = currentArray;
  }

  agent.instructions = body;
  return agent;
}

function parseBodyOnly(id: string, raw: string): AgentDefinition {
  const lines = raw.trim().split(/\r?\n/);
  let name = id;
  let start = 0;

  if (lines[0]?.startsWith("# ")) {
    name = lines[0].slice(2).trim();
    start = 1;
    if (lines[start]?.trim() === "") start++;
  }

  return {
    id,
    name,
    instructions: lines.slice(start).join("\n").trim(),
  };
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

const adapter = new CopilotAgentAdapter();
registry.register(adapter);

export { CopilotAgentAdapter };
export default adapter;
