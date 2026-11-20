import { BaseSkillAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, SkillDefinition, SkillLayer } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

class KiroSkillAdapter extends BaseSkillAdapter {
  readonly id = "kiro";
  readonly name = "Kiro";
  readonly nativeSupport = true;
  readonly configDir = ".kiro/skills";
  override readonly userConfigDir = ".kiro/skills";
  override readonly command = "kiro";

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
      const content = await readFile(skillPath, "utf-8");
      skills.push(parseSkill(entry.name, content));
    }

    return skills;
  }

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configDir))) return true;
    return (await this.commandExists("kiro")) || (await this.commandExists("kiro-cli"));
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const skillsDir = resolve(dir, this.configDir);
    if (!existsSync(skillsDir)) return;

    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const entryDir = resolve(skillsDir, entry.name);
      if (existsSync(resolve(entryDir, "SKILL.md"))) {
        await rm(entryDir, { recursive: true, force: true });
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

function parseSkill(id: string, raw: string): SkillDefinition {
  const normalized = raw.replace(/\r\n?/g, "\n").trim();
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
    const value = line.slice(colon + 1).trim();
    if (key === "name" && value) name = value;
    if (key === "description" && value) description = value;
  }

  return { id, name, description, content: body };
}

const adapter = new KiroSkillAdapter();
registry.register(adapter);
export { KiroSkillAdapter };
export default adapter;
