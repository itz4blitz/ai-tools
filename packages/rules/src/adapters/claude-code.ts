import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { RuleDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export class ClaudeCodeRuleAdapter extends BaseRuleAdapter {
  readonly id = "claude-code";
  readonly name = "Claude Code";
  readonly nativeSupport = true;
  readonly configDir = ".claude/rules";
  readonly command = "claude";

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

    const entries = await readdir(rulesDir, { recursive: true, withFileTypes: true });
    const rules: RuleDefinition[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const fullPath = join(entry.parentPath, entry.name);
      const rel = relative(rulesDir, fullPath).split(sep).join("/");
      const id = rel.slice(0, -".md".length);
      const content = await readFile(fullPath, "utf-8");
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
      md += "paths:\n";
      for (const pattern of rule.scope.patterns) {
        md += `  - ${JSON.stringify(pattern)}\n`;
      }
    }
    md += "---\n\n";
    md += rule.content + "\n";
    return md;
  }

  private parseRule(id: string, raw: string): RuleDefinition {
    const normalized = raw.replace(/\r\n/g, "\n");
    const rule: RuleDefinition = { id, name: id, content: "", scope: { type: "always" } };

    if (normalized.startsWith("---\n") || normalized.startsWith("---")) {
      const match = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(normalized);
      if (match) {
        const fm = (match[1] ?? "").trim();
        const body = (match[2] ?? "").trim();

        const patterns: string[] = [];
        let activeKey = "";

        for (const line of fm.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith("- ")) {
            if (activeKey === "paths" || activeKey === "globs") {
              const pattern = unquoteYaml(trimmed.slice(2).trim());
              if (pattern) patterns.push(pattern);
            }
            continue;
          }

          const colonIdx = line.indexOf(":");
          if (colonIdx === -1) continue;

          activeKey = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();

          if (activeKey === "description" && value) {
            rule.description = unquoteYaml(value);
          } else if ((activeKey === "paths" || activeKey === "globs") && value) {
            patterns.push(...parseInlineList(value));
          }
        }

        if (patterns.length > 0) {
          rule.scope = { type: "glob", patterns };
        }

        rule.content = body;
        return rule;
      }
    }

    rule.content = normalized.trim();
    return rule;
  }
}

function unquoteYaml(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value) as string;
      } catch {
        return value.slice(1, -1);
      }
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseInlineList(raw: string): string[] {
  const inner = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  return inner
    .split(",")
    .map((item) => unquoteYaml(item.trim()))
    .filter((item) => item.length > 0);
}

const adapter = new ClaudeCodeRuleAdapter();
registry.register(adapter);
export default adapter;
