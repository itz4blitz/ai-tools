import { BaseSkillAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { SkillDefinition, GeneratedFile, SkillLayer } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

class ClineSkillAdapter extends BaseSkillAdapter {
  readonly id = "cline";
  readonly name = "Cline";
  readonly nativeSupport = true;
  readonly configDir = ".cline/skills";
  override readonly userConfigDir = ".cline/skills";
  readonly command = "cline";

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
    if (!existsSync(skillsDir)) return;

    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = resolve(skillsDir, entry.name);
      if (existsSync(resolve(skillDir, "SKILL.md"))) {
        await rm(skillDir, { recursive: true, force: true });
      }
    }

    const remaining = await readdir(skillsDir);
    if (remaining.length === 0) {
      await rm(skillsDir, { recursive: true, force: true });
    }
  }
}

function formatSkill(skill: SkillDefinition): string {
  const description = skill.description ?? skill.name;
  return `---\nname: ${skill.id}\ndescription: ${description}\n---\n\n${skill.content}\n`;
}

function unquoteYamlValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseSkill(id: string, raw: string): SkillDefinition {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
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
    const value = unquoteYamlValue(line.slice(colon + 1).trim());
    if (key === "name" && value) name = value;
    if (key === "description" && value) description = value;
  }

  return { id, name, description, content: body };
}

const adapter = new ClineSkillAdapter();
registry.register(adapter);
export { ClineSkillAdapter };
export default adapter;
