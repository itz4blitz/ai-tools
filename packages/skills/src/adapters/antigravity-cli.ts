import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { GeneratedFile, SkillDefinition, SkillLayer } from "../types/index.js";
import { BaseSkillAdapter } from "./base.js";
import { registry } from "./registry.js";

export class AntigravityCliSkillAdapter extends BaseSkillAdapter {
  readonly id = "antigravity-cli";
  readonly name = "Antigravity CLI";
  readonly nativeSupport = true;
  readonly configDir = ".agents/skills";
  override readonly userConfigDir = ".gemini/config/skills";
  override readonly command = "agy";

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configDir))) return true;
    if (existsSync(join(homedir(), ".gemini", "antigravity-cli", "settings.json"))) return true;
    return this.commandExists(this.command);
  }

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
      try {
        const content = await readFile(skillPath, "utf-8");
        skills.push(parseSkill(entry.name, content));
      } catch {
        // Ignore folders that cannot be read as Antigravity/Open Agent skill folders.
      }
    }

    return skills;
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const skillsDir = resolve(dir, this.configDir);
    if (!existsSync(skillsDir)) return;
    await rm(skillsDir, { recursive: true, force: true });
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

function parseFrontmatter(rawInput: string): { metadata: Record<string, string>; body: string } {
  const raw = rawInput.replace(/\r\n/g, "\n");
  if (!raw.startsWith("---\n")) return { metadata: {}, body: raw };

  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { metadata: {}, body: raw };

  const metadata: Record<string, string> = {};
  const lines = raw.slice(4, end).split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const colon = line.indexOf(":");
    if (colon === -1) continue;

    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (!key) continue;

    if (
      rawValue === ">" ||
      rawValue === ">-" ||
      rawValue === ">+" ||
      rawValue === "|" ||
      rawValue === "|-" ||
      rawValue === "|+"
    ) {
      const folded = rawValue.startsWith(">");
      const blockLines: string[] = [];
      let baseIndent: number | null = null;

      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1] ?? "";
        if (nextLine.trim() === "") {
          blockLines.push("");
          i++;
          continue;
        }
        const indentMatch = /^(\s+)/.exec(nextLine);
        if (!indentMatch?.[1]) break;
        const indent = indentMatch[1].length;
        if (baseIndent === null) baseIndent = indent;
        blockLines.push(nextLine.slice(Math.min(indent, baseIndent)));
        i++;
      }

      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
        blockLines.pop();
      }

      metadata[key] = folded ? foldYamlBlock(blockLines) : blockLines.join("\n").trim();
      continue;
    }

    metadata[key] = stripQuotes(rawValue);
  }

  return { metadata, body: raw.slice(end + 4) };
}

function foldYamlBlock(lines: string[]): string {
  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    } else {
      current.push(line.trim());
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.join(" "));
  }

  return paragraphs.join("\n").trim();
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

const adapter = new AntigravityCliSkillAdapter();
registry.register(adapter);
export default adapter;
