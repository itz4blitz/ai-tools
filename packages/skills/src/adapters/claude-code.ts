import { BaseSkillAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { SkillDefinition, GeneratedFile, SkillLayer } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
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
}

function formatSkill(skill: SkillDefinition): string {
  const description = skill.description ?? skill.name;
  return `---\nname: ${skill.id}\ndescription: ${description}\n---\n\n${skill.content}\n`;
}

function parseSkill(id: string, raw: string): SkillDefinition {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.trim());
  if (!match) {
    return { id, name: id, content: raw.trim() };
  }
  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  let name = id;
  let description: string | undefined;
  for (const line of frontmatter.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
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
