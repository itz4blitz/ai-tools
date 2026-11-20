import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { BaseSkillAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, SkillDefinition, SkillLayer } from "../types/index.js";

const LEGACY_PROMPTS_DIR = ".continue/prompts";

class ContinueSkillAdapter extends BaseSkillAdapter {
  readonly id = "continue";
  readonly name = "Continue";
  readonly nativeSupport = true;
  readonly configDir = ".continue/skills";
  readonly userConfigDir = ".continue/skills";
  readonly command = "cn";

  async generate(skills: SkillDefinition[], layer?: SkillLayer): Promise<GeneratedFile[]> {
    return this.skillFolders(skills, this.skillsDir(layer), formatSkill);
  }

  async import(cwd?: string): Promise<SkillDefinition[]> {
    const dir = cwd ?? process.cwd();
    const skills: SkillDefinition[] = [];
    const seen = new Set<string>();

    const skillsDir = resolve(dir, this.configDir);
    if (existsSync(skillsDir)) {
      const entries = await readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillPath = resolve(skillsDir, entry.name, "SKILL.md");
        if (!existsSync(skillPath)) continue;
        const raw = await readFile(skillPath, "utf-8");
        skills.push(parseSkill(entry.name, raw));
        seen.add(entry.name);
      }
    }

    const promptsDir = resolve(dir, LEGACY_PROMPTS_DIR);
    if (existsSync(promptsDir)) {
      const files = await readdir(promptsDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const id = basename(file, ".md");
        if (seen.has(id)) continue;
        const raw = await readFile(resolve(promptsDir, file), "utf-8");
        skills.push(parseSkill(id, raw));
        seen.add(id);
      }
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
  return `---\nname: ${formatYamlScalar(skill.name)}\ndescription: ${formatYamlScalar(description)}\ninvokable: true\n---\n\n${skill.content}\n`;
}

function parseSkill(id: string, raw: string): SkillDefinition {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized.trimStart());
  if (match) {
    const frontmatter = match[1] ?? "";
    const body = (match[2] ?? "").trim();
    let name = id;
    let description: string | undefined;
    for (const line of frontmatter.split("\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const value = unquoteYamlScalar(line.slice(colon + 1).trim());
      if (key === "name" && value) name = value;
      if (key === "description" && value) description = value;
    }
    const skill: SkillDefinition = { id, name, content: body };
    if (description !== undefined) skill.description = description;
    return skill;
  }

  const lines = normalized.trim().split("\n");
  let name = id;
  let contentStart = 0;

  if (lines[0]?.startsWith("# ")) {
    name = lines[0].slice(2).trim() || id;
    contentStart = 1;
    if (lines[contentStart]?.trim() === "") contentStart++;
  }

  return {
    id,
    name,
    content: lines.slice(contentStart).join("\n").trim(),
  };
}

function formatYamlScalar(value: string): string {
  if (/[:#[\]{}&*!|>'"%@`,?]|^\s|\s$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function unquoteYamlScalar(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    if (value.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed === "string") return parsed;
      } catch {
        // fall through to simple slice
      }
    }
    return value.slice(1, -1);
  }
  return value;
}

const adapter = new ContinueSkillAdapter();
registry.register(adapter);
export { ContinueSkillAdapter };
export default adapter;
