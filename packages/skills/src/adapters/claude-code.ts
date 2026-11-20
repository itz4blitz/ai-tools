import { BaseSkillAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { SkillDefinition, GeneratedFile, SkillLayer } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

class ClaudeCodeSkillAdapter extends BaseSkillAdapter {
  readonly id = "claude-code";
  readonly name = "Claude Code";
  readonly nativeSupport = true;
  readonly configDir = ".claude/skills";
  readonly command = "claude";

  async generate(skills: SkillDefinition[], layer?: SkillLayer): Promise<GeneratedFile[]> {
    return this.skillFolders(skills, this.skillsDir(layer), formatSkill);
  }

  async import(cwd?: string): Promise<SkillDefinition[]> {
    return importSkillMd(this.configDir, cwd);
  }

  async importUser(): Promise<SkillDefinition[]> {
    return importSkillMd(this.skillsDir("user"), homedir());
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const skillsDir = resolve(dir, this.configDir);
    if (existsSync(skillsDir)) {
      await rm(skillsDir, { recursive: true, force: true });
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

function formatSkill(skill: SkillDefinition): string {
  const description = skill.description ?? skill.name;
  return `---\nname: ${formatYamlValue(skill.id)}\ndescription: ${formatYamlValue(description)}\n---\n\n${skill.content}\n`;
}

function parseSkill(id: string, raw: string): SkillDefinition {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized.trim());
  if (!match) {
    return { id, name: id, content: normalized.trim() };
  }
  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  let name = id;
  let description: string | undefined;
  for (const line of frontmatter.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = unquoteYaml(line.slice(colon + 1).trim());
    if (key === "name") name = value;
    if (key === "description") description = value;
  }
  return { id, name, description, content: body };
}

async function importSkillMd(configDir: string, cwd?: string): Promise<SkillDefinition[]> {
  const dir = cwd ?? process.cwd();
  const skillsDir = resolve(dir, configDir);
  if (!existsSync(skillsDir)) return [];

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: SkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = resolve(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    skills.push(parseSkill(entry.name, await readFile(skillPath, "utf-8")));
  }
  return skills;
}

const adapter = new ClaudeCodeSkillAdapter();
registry.register(adapter);
export { ClaudeCodeSkillAdapter };
export default adapter;
