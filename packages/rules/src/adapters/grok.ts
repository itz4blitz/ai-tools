import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, RuleDefinition } from "../types/index.js";

export class GrokRuleAdapter extends BaseRuleAdapter {
  readonly id = "grok";
  readonly name = "Grok";
  readonly nativeSupport = true;
  readonly configDir = ".grok/rules";
  readonly command = "grok";

  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    return rules.map((rule) => ({
      path: `${this.configDir}/${rule.id}.md`,
      content: this.formatRule(rule),
      format: "md" as const,
    }));
  }

  async import(cwd?: string): Promise<RuleDefinition[]> {
    const dir = cwd ?? process.cwd();
    const rulesDir = resolve(dir, this.configDir);
    if (!existsSync(rulesDir)) return [];

    const files = (await readdir(rulesDir)).toSorted();
    const rules: RuleDefinition[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const content = await readFile(resolve(rulesDir, file), "utf-8");
      const id = basename(file, ".md");
      rules.push(this.parseRule(id, content));
    }

    return rules;
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const rulesDir = resolve(dir, this.configDir);
    if (existsSync(rulesDir)) {
      await rm(rulesDir, { recursive: true, force: true });
    }
  }

  private formatRule(rule: RuleDefinition): string {
    let md = "---\n";
    if (rule.description) md += `description: ${rule.description}\n`;
    if (rule.scope.type === "glob" && rule.scope.patterns.length > 0) {
      md += "globs:\n";
      for (const pattern of rule.scope.patterns) {
        md += `  - "${pattern}"\n`;
      }
    }
    md += "---\n\n";
    md += `${rule.content}\n`;
    return md;
  }

  private parseRule(id: string, raw: string): RuleDefinition {
    const rule: RuleDefinition = { id, name: id, content: "", scope: { type: "always" } };
    const trimmed = raw.trim();
    const match = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n([\s\S]*))?$/.exec(trimmed);

    if (match) {
      const fm = match[1] ?? "";
      const body = (match[2] ?? "").trim();
      const globs: string[] = [];
      let inGlobs = false;

      for (const line of fm.split(/\r?\n/)) {
        const trimmedLine = line.trim();
        if (trimmedLine.startsWith("description:")) {
          inGlobs = false;
          rule.description = trimmedLine
            .slice("description:".length)
            .trim()
            .replace(/^["']|["']$/g, "");
        } else if (trimmedLine === "globs:") {
          inGlobs = true;
        } else if (inGlobs && trimmedLine.startsWith("- ")) {
          const pattern = trimmedLine
            .slice(2)
            .trim()
            .replace(/^["']|["']$/g, "");
          if (pattern) globs.push(pattern);
        } else if (trimmedLine && !trimmedLine.startsWith("- ")) {
          inGlobs = false;
        }
      }

      if (globs.length > 0) {
        rule.scope = { type: "glob", patterns: globs };
      }

      rule.content = body;
      return rule;
    }

    const lines = trimmed.split(/\r?\n/);
    let contentStart = 0;
    if (lines[0]?.startsWith("# ")) {
      rule.name = lines[0].slice(2).trim();
      contentStart = 1;
      if (lines[contentStart]?.trim() === "") contentStart++;
    }
    rule.content = lines.slice(contentStart).join("\n").trim();
    return rule;
  }
}

const adapter = new GrokRuleAdapter();
registry.register(adapter);
export default adapter;
