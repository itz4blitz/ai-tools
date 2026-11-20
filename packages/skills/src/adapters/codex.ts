import { BaseSkillAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { SkillDefinition, GeneratedFile, SkillLayer } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const LEGACY_CONFIG_DIR = ".codex/skills";

class CodexSkillAdapter extends BaseSkillAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  readonly nativeSupport = true;
  /** Codex reads both project and user skills from `.agents/skills` (with `.codex/skills` fallback). */
  readonly configDir = ".agents/skills";
  override readonly userConfigDir = ".agents/skills";
  readonly command = "codex";

  async generate(skills: SkillDefinition[], layer?: SkillLayer): Promise<GeneratedFile[]> {
    return this.skillFolders(skills, this.skillsDir(layer), formatSkill);
  }

  override async detect(cwd?: string, layer: SkillLayer = "project"): Promise<boolean> {
    const baseDir = resolveBaseDir(cwd, layer);
    if (
      existsSync(resolve(baseDir, this.skillsDir(layer))) ||
      existsSync(resolve(baseDir, LEGACY_CONFIG_DIR))
    ) {
      return true;
    }
    return this.commandExists(this.command);
  }

  async import(cwd?: string, layer: SkillLayer = "project"): Promise<SkillDefinition[]> {
    const baseDir = resolveBaseDir(cwd, layer);
    const primaryDir = resolve(baseDir, this.skillsDir(layer));
    const fallbackDir = resolve(baseDir, LEGACY_CONFIG_DIR);

    const skills: SkillDefinition[] = [];
    const seen = new Set<string>();

    for (const dir of [primaryDir, fallbackDir]) {
      const imported = await importSkillMdFromDir(dir);
      for (const skill of imported) {
        if (seen.has(skill.id)) continue;
        seen.add(skill.id);
        skills.push(skill);
      }
    }

    return skills;
  }

  override async uninstall(cwd?: string, layer: SkillLayer = "project"): Promise<void> {
    const baseDir = resolveBaseDir(cwd, layer);
    const dirsToClean = [resolve(baseDir, this.skillsDir(layer))];
    if (layer === "project") {
      dirsToClean.push(resolve(baseDir, LEGACY_CONFIG_DIR));
    }

    for (const skillsDir of dirsToClean) {
      if (!existsSync(skillsDir)) continue;
      const entries = await readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
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
}

function resolveBaseDir(cwd: string | undefined, layer: SkillLayer): string {
  if (cwd !== undefined) return cwd;
  return layer === "user" ? homedir() : process.cwd();
}

const NEEDS_YAML_QUOTING =
  /^[\s-?:,[\]{}#&*!|>'"%@`]|[\s]$|[:#\n\r]|^(?:true|false|null|~|-?\d+(?:\.\d+)?)$/i;

function yamlScalar(value: string): string {
  if (value === "" || NEEDS_YAML_QUOTING.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function unquoteYamlScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function formatSkill(skill: SkillDefinition): string {
  const description = skill.description ?? skill.name;
  return `---\nname: ${yamlScalar(skill.id)}\ndescription: ${yamlScalar(description)}\n---\n\n${skill.content}\n`;
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
    const value = unquoteYamlScalar(line.slice(colon + 1));
    if (key === "name") name = value;
    if (key === "description") description = value;
  }
  return { id, name, description, content: body };
}

async function importSkillMdFromDir(skillsDir: string): Promise<SkillDefinition[]> {
  if (!existsSync(skillsDir)) return [];

  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skills: SkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillPath = resolve(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    skills.push(parseSkill(entry.name, await readFile(skillPath, "utf-8")));
  }
  return skills;
}

const adapter = new CodexSkillAdapter();
registry.register(adapter);
export { CodexSkillAdapter };
export default adapter;
