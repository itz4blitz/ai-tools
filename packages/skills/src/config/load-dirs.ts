import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SkillDefinition } from "../types/index.js";

/**
 * Read every `<root>/<id>/SKILL.md` folder (e.g. a cloned skills repo) into skill definitions.
 * Folder-based adapters copy each folder verbatim, so supporting files travel with the skill.
 */
export function loadSkillDirs(root: string): SkillDefinition[] {
  const base = resolve(root);
  const skills: SkillDefinition[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceDir = join(base, entry.name);
    const skillPath = join(sourceDir, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const raw = readFileSync(skillPath, "utf-8").replace(/\r\n/g, "\n");
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
    const fields: Record<string, string> = {};
    for (const line of (match?.[1] ?? "").split("\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      fields[line.slice(0, colon).trim()] = unquote(line.slice(colon + 1).trim());
    }
    skills.push({
      id: entry.name,
      name: fields["name"] ?? entry.name,
      description: fields["description"],
      content: (match ? (match[2] ?? "") : raw).trim(),
      sourceDir,
    });
  }
  return skills;
}

function unquote(value: string): string {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
  return quoted ? (quoted[2] ?? "") : value;
}
