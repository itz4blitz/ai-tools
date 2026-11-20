import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, RuleDefinition } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

export class KiroRuleAdapter extends BaseRuleAdapter {
  readonly id = "kiro";
  readonly name = "Kiro";
  readonly nativeSupport = true;
  readonly configDir = ".kiro/steering";
  override readonly command = "kiro";

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

    const files = await readdir(rulesDir);
    const rules: RuleDefinition[] = [];

    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const content = await readFile(resolve(rulesDir, file), "utf-8");
      rules.push(this.parseRule(basename(file, ".md"), content));
    }

    return rules;
  }

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configDir))) return true;
    return (await this.commandExists("kiro")) || (await this.commandExists("kiro-cli"));
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const rulesDir = resolve(dir, this.configDir);
    if (!existsSync(rulesDir)) return;

    const files = await readdir(rulesDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      await rm(resolve(rulesDir, file), { force: true });
    }

    const remaining = await readdir(rulesDir);
    if (remaining.length === 0) {
      await rm(rulesDir, { recursive: true, force: true });
    }
  }

  private formatRule(rule: RuleDefinition): string {
    const lines: string[] = ["---"];
    if (rule.description) {
      lines.push(`description: ${rule.description}`);
    }

    if (rule.scope.type === "glob" && rule.scope.patterns.length > 0) {
      lines.push("inclusion: fileMatch");
      if (rule.scope.patterns.length === 1) {
        lines.push(`fileMatchPattern: "${rule.scope.patterns[0]}"`);
      } else {
        lines.push("fileMatchPattern:");
        for (const pattern of rule.scope.patterns) {
          lines.push(`  - "${pattern}"`);
        }
      }
    } else if (rule.scope.type === "manual" || rule.scope.type === "agent") {
      lines.push("inclusion: manual");
    } else {
      lines.push("inclusion: always");
    }

    lines.push("---", "");
    return `${lines.join("\n")}\n${rule.content}\n`;
  }

  private parseRule(id: string, raw: string): RuleDefinition {
    const normalized = raw.replace(/\r\n?/g, "\n");
    const rule: RuleDefinition = {
      id,
      name: id,
      content: "",
      scope: { type: "always" },
    };

    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized.trimStart());
    if (match) {
      const fm = match[1] ?? "";
      const body = (match[2] ?? "").trim();

      let inclusion = "always";
      const patterns: string[] = [];
      let inPatternList = false;

      for (const line of fm.split("\n")) {
        const trimmed = line.trim();
        if (inPatternList && trimmed.startsWith("- ")) {
          const pat = stripQuotes(trimmed.slice(2).trim());
          if (pat) patterns.push(pat);
          continue;
        }
        inPatternList = false;

        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();

        if (key === "description" && value) {
          rule.description = stripQuotes(value);
        } else if (key === "inclusion" && value) {
          inclusion = stripQuotes(value);
        } else if (key === "fileMatchPattern") {
          if (value) {
            patterns.push(stripQuotes(value));
          } else {
            inPatternList = true;
          }
        }
      }

      if (inclusion === "fileMatch" && patterns.length > 0) {
        rule.scope = { type: "glob", patterns };
      } else if (inclusion === "manual") {
        rule.scope = { type: "manual" };
      } else {
        rule.scope = { type: "always" };
      }

      const bodyLines = body.split("\n");
      if (bodyLines[0]?.startsWith("# ")) {
        rule.name = bodyLines[0].slice(2).trim() || id;
      }
      rule.content = body;
      return rule;
    }

    const lines = normalized.trim().split("\n");
    let contentStart = 0;
    if (lines[0]?.startsWith("# ")) {
      rule.name = lines[0].slice(2).trim() || id;
      contentStart = 1;
      if (lines[contentStart]?.trim() === "") contentStart++;
    }
    rule.content = lines.slice(contentStart).join("\n").trim();
    return rule;
  }
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

const adapter = new KiroRuleAdapter();
registry.register(adapter);
export default adapter;
