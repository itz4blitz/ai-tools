import { BaseAgentAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { AgentDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

type KiroJsonAgent = {
  name?: unknown;
  description?: unknown;
  prompt?: unknown;
  instructions?: unknown;
  model?: unknown;
  tools?: unknown;
  allowedTools?: unknown;
};

class KiroAgentAdapter extends BaseAgentAdapter {
  readonly id = "kiro";
  readonly name = "Kiro";
  readonly nativeSupport = true;
  readonly configDir = ".kiro/agents";
  override readonly command = "kiro";

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
      const fullPath = resolve(agentsDir, file);
      if (file.endsWith(".md")) {
        const content = await readFile(fullPath, "utf-8");
        agents.push(parseMarkdownAgent(basename(file, ".md"), content));
      } else if (file.endsWith(".json")) {
        const raw = await readFile(fullPath, "utf-8");
        const parsed = parseJsonAgent(basename(file, ".json"), raw);
        if (parsed) agents.push(parsed);
      }
    }

    return agents;
  }

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configDir))) return true;
    return (await this.commandExists("kiro")) || (await this.commandExists("kiro-cli"));
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const agentsDir = resolve(dir, this.configDir);
    if (!existsSync(agentsDir)) return;

    const files = await readdir(agentsDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
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
  if (agent.description) lines.push(`description: ${agent.description}`);
  if (agent.tools?.length) {
    lines.push("tools:");
    for (const tool of agent.tools) {
      lines.push(`  - ${tool}`);
    }
  }
  if (agent.model) lines.push(`model: ${agent.model}`);
  lines.push("---", "");
  lines.push(`# ${agent.name}`, "");
  lines.push(agent.instructions);
  return `${lines.join("\n")}\n`;
}

function parseMarkdownAgent(id: string, raw: string): AgentDefinition {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const agent: AgentDefinition = { id, name: id, instructions: "" };

  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized.trimStart());
  let body = normalized;

  if (match) {
    const fm = match[1] ?? "";
    body = (match[2] ?? "").trim();

    let currentKey = "";
    let currentArray: string[] = [];

    for (const line of fm.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") && currentKey === "tools") {
        currentArray.push(trimmed.slice(2).trim());
        continue;
      }

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

    if (currentKey === "tools" && currentArray.length > 0) {
      agent.tools = currentArray;
    }
  }

  const bodyLines = body.trim().split("\n");
  let contentStart = 0;
  if (bodyLines[0]?.startsWith("# ")) {
    const heading = bodyLines[0].slice(2).trim();
    if (agent.name === id && heading) {
      agent.name = heading;
    }
    contentStart = 1;
    if (bodyLines[contentStart]?.trim() === "") contentStart++;
  }
  agent.instructions = bodyLines.slice(contentStart).join("\n").trim();

  return agent;
}

function parseJsonAgent(id: string, raw: string): AgentDefinition | null {
  let data: KiroJsonAgent;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    data = parsed as KiroJsonAgent;
  } catch {
    return null;
  }

  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : id;
  const description =
    typeof data.description === "string" && data.description.trim()
      ? data.description.trim()
      : undefined;
  const instructions =
    typeof data.prompt === "string"
      ? data.prompt
      : typeof data.instructions === "string"
        ? data.instructions
        : "";
  const model = typeof data.model === "string" && data.model.trim() ? data.model.trim() : undefined;

  const rawTools = Array.isArray(data.tools)
    ? data.tools
    : Array.isArray(data.allowedTools)
      ? data.allowedTools
      : undefined;
  const tools = rawTools?.filter((t): t is string => typeof t === "string");

  const agent: AgentDefinition = { id, name, instructions };
  if (description) agent.description = description;
  if (model) agent.model = model;
  if (tools && tools.length > 0) agent.tools = tools;
  return agent;
}

const adapter = new KiroAgentAdapter();
registry.register(adapter);

export { KiroAgentAdapter };
export default adapter;
