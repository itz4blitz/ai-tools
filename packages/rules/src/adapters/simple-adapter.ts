import { BaseRuleAdapter } from "./base.js";
import type { RuleDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";

export abstract class SimpleMarkdownRuleAdapter extends BaseRuleAdapter {
  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    return rules.map((rule) => ({
      path: `${this.configDir}/${rule.id}.md`,
      content: `# ${rule.name}\n\n${rule.content}\n`,
      format: "md" as const,
    }));
  }

  async import(cwd?: string): Promise<RuleDefinition[]> {
    const dir = cwd ?? process.cwd();
    const rulesDir = resolve(dir, this.configDir);
    if (!existsSync(rulesDir)) return [];

    const files = await readdir(rulesDir);
    const rules: RuleDefinition[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const content = await readFile(resolve(rulesDir, file), "utf-8");
      const id = basename(file, ".md");
      rules.push(this.parseSimpleRule(id, content));
    }

    return rules;
  }

  private parseSimpleRule(id: string, raw: string): RuleDefinition {
    const lines = raw.trim().split(/\r?\n/);
    let name = id;
    let contentStart = 0;

    if (lines[0]?.startsWith("# ")) {
      name = lines[0].slice(2).trim();
      contentStart = 1;
      if (lines[contentStart]?.trim() === "") contentStart++;
    }

    const content = lines.slice(contentStart).join("\n").trim();
    return { id, name, content, scope: { type: "always" } };
  }
}
