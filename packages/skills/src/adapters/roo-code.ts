import { BaseSkillAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { SkillDefinition, SkillLayer, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

class RooCodeSkillAdapter extends BaseSkillAdapter {
  readonly id = "roo-code";
  readonly name = "Roo Code";
  readonly nativeSupport = true;
  readonly configDir = ".roo/skills";
  override readonly userConfigDir = ".roo/skills";

  async generate(skills: SkillDefinition[], layer?: SkillLayer): Promise<GeneratedFile[]> {
    return this.skillFolders(skills, this.skillsDir(layer), formatSkill);
  }

  async import(cwd?: string): Promise<SkillDefinition[]> {
    const dir = cwd ?? process.cwd();
    const skillsDir = resolve(dir, this.configDir);
    if (!existsSync(skillsDir)) return [];

    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skills: SkillDefinition[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = resolve(skillsDir, entry.name, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      const raw = await readFile(skillPath, "utf-8");
      skills.push(parseSkill(entry.name, raw));
    }

    return skills;
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const skillsDir = resolve(dir, this.configDir);
    if (existsSync(skillsDir)) {
      await rm(skillsDir, { recursive: true, force: true });
    }
  }
}

function formatSkill(skill: SkillDefinition): string {
  const description = skill.description ?? skill.name;
  return `---\nname: ${skill.id}\ndescription: ${description}\n---\n\n${skill.content}\n`;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseSkill(id: string, raw: string): SkillDefinition {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  const match = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(normalized);
  if (!match) {
    const lines = normalized.split("\n");
    if (lines[0]?.startsWith("# ")) {
      const name = lines[0].slice(2).trim();
      let contentStart = 1;
      if (lines[contentStart]?.trim() === "") contentStart++;
      return { id, name, content: lines.slice(contentStart).join("\n").trim() };
    }
    return { id, name: id, content: normalized };
  }

  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  let name = id;
  let description: string | undefined;

  for (const line of frontmatter.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = stripQuotes(line.slice(colon + 1).trim());
    if (key === "name" && value) name = value;
    if (key === "description" && value) description = value;
  }

  return description !== undefined
    ? { id, name, description, content: body }
    : { id, name, content: body };
}

const adapter = new RooCodeSkillAdapter();
registry.register(adapter);
export { RooCodeSkillAdapter };
export default adapter;
