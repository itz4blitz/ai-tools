import { BaseSkillAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, SkillDefinition, SkillLayer } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export class AntigravityCliSkillAdapter extends BaseSkillAdapter {
  readonly id = "antigravity-cli";
  readonly name = "Antigravity CLI";
  readonly nativeSupport = true;
  readonly configDir = ".agents/skills";
  readonly command = "antigravity";

  async generate(skills: SkillDefinition[], layer?: SkillLayer): Promise<GeneratedFile[]> {
    return this.skillFolders(skills, this.skillsDir(layer), formatSkill);
  }

  async import(cwd?: string): Promise<SkillDefinition[]> {
    const dir = cwd ?? process.cwd();
    const skillsDir = resolve(dir, this.configDir);
    if (!existsSync(skillsDir)) return [];

    const entries = await readdir(skillsDir);
    const skills: SkillDefinition[] = [];

    for (const entry of entries) {
      try {
        const content = await readFile(resolve(skillsDir, entry, "SKILL.md"), "utf-8");
        skills.push(parseSkill(entry, content));
      } catch {
        // Ignore folders that are not Antigravity/Open Agent skill folders.
      }
    }

    return skills;
  }
}

function formatSkill(skill: SkillDefinition): string {
  return [
    "---",
    `name: ${skill.id}`,
    `description: ${skill.description ?? skill.name}`,
    "---",
    "",
    skill.content,
    "",
  ].join("\n");
}

function parseSkill(id: string, raw: string): SkillDefinition {
  const { metadata, body } = parseFrontmatter(raw);
  return {
    id,
    name: metadata.name ?? id,
    description: metadata.description,
    content: body.trim(),
  };
}

function parseFrontmatter(raw: string): { metadata: Record<string, string>; body: string } {
  if (!raw.startsWith("---")) return { metadata: {}, body: raw };

  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { metadata: {}, body: raw };

  const metadata: Record<string, string> = {};
  const frontmatter = raw.slice(3, end).trim();
  for (const line of frontmatter.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    metadata[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }

  return { metadata, body: raw.slice(end + 4) };
}

const adapter = new AntigravityCliSkillAdapter();
registry.register(adapter);
export default adapter;
