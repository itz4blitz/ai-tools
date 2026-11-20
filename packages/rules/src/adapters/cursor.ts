import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { RuleDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitRespectingQuotesAndBraces(input: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let braceDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] ?? "";
    if (quote) {
      if (ch === quote && input[i - 1] !== "\\") {
        quote = null;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "{") {
      braceDepth++;
      current += ch;
    } else if (ch === "}") {
      if (braceDepth > 0) braceDepth--;
      current += ch;
    } else if (ch === "," && braceDepth === 0) {
      const cleaned = unquote(current);
      if (cleaned.length > 0) items.push(cleaned);
      current = "";
    } else {
      current += ch;
    }
  }

  const cleaned = unquote(current);
  if (cleaned.length > 0) items.push(cleaned);
  return items;
}

function parseInlineGlobs(rawValue: string): string[] {
  const trimmed = rawValue.trim();
  if (!trimmed) return [];

  // Inline YAML array: ["*.ts", "src/**/*.{ts,tsx}"] or ['*.ts']
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return splitRespectingQuotesAndBraces(inner);
  }

  // Unquote a single outer-quoted scalar such as "*.ts, *.tsx" before splitting
  const unwrapped = unquote(trimmed);
  return splitRespectingQuotesAndBraces(unwrapped);
}

async function collectMdcFiles(currentDir: string): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMdcFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".mdc")) {
      files.push(fullPath);
    }
  }

  return files;
}

export class CursorRuleAdapter extends BaseRuleAdapter {
  readonly id = "cursor";
  readonly name = "Cursor";
  readonly nativeSupport = true;
  readonly configDir = ".cursor/rules";
  readonly command = "cursor";

  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    return rules.map((rule) => ({
      path: `${this.configDir}/${rule.id}.mdc`,
      content: this.formatRule(rule),
      format: "md" as const,
    }));
  }

  async import(cwd?: string): Promise<RuleDefinition[]> {
    const dir = cwd ?? process.cwd();
    const rulesDir = resolve(dir, this.configDir);
    if (!existsSync(rulesDir)) return [];

    const mdcFiles = await collectMdcFiles(rulesDir);
    const rules: RuleDefinition[] = [];

    for (const filePath of mdcFiles) {
      const content = await readFile(filePath, "utf-8");
      const rel = relative(rulesDir, filePath).split(sep).join("/");
      const id = rel.replace(/\.mdc$/, "");
      rules.push(this.parseRule(id, content));
    }

    return rules;
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const rulesDir = resolve(dir, this.configDir);
    if (!existsSync(rulesDir)) return;
    await rm(rulesDir, { recursive: true, force: true });
  }

  private formatRule(rule: RuleDefinition): string {
    let md = "---\n";
    if (rule.description) md += `description: ${rule.description}\n`;
    md += `alwaysApply: ${rule.scope.type === "always"}\n`;
    if (rule.scope.type === "glob" && rule.scope.patterns.length > 0) {
      md += "globs:\n";
      for (const pattern of rule.scope.patterns) {
        md += `  - "${pattern}"\n`;
      }
    }
    md += "---\n\n";
    md += rule.content + "\n";
    return md;
  }

  private parseRule(id: string, raw: string): RuleDefinition {
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const rule: RuleDefinition = {
      id,
      name: id,
      content: normalized.trim(),
      scope: { type: "always" },
    };

    const fmMatch = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(normalized);
    if (!fmMatch) {
      return rule;
    }

    const fm = (fmMatch[1] ?? "").trim();
    const body = (fmMatch[2] ?? "").trim();

    const globs: string[] = [];
    let alwaysApply = false;
    let inGlobsBlock = false;

    const lines = fm.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        if (inGlobsBlock) {
          const pattern = unquote(trimmed.slice(2));
          if (pattern) globs.push(pattern);
        }
        continue;
      }

      if (line.startsWith("description:")) {
        inGlobsBlock = false;
        rule.description = unquote(line.slice(12));
      } else if (line.startsWith("alwaysApply:")) {
        inGlobsBlock = false;
        alwaysApply = line.slice(12).trim() === "true";
      } else if (line.startsWith("globs:")) {
        const inline = line.slice(6).trim();
        if (inline) {
          inGlobsBlock = false;
          globs.push(...parseInlineGlobs(inline));
        } else {
          inGlobsBlock = true;
        }
      } else if (line.includes(":")) {
        inGlobsBlock = false;
      }
    }

    if (globs.length > 0) {
      rule.scope = { type: "glob", patterns: globs };
    } else if (alwaysApply) {
      rule.scope = { type: "always" };
    } else {
      rule.scope = { type: "manual" };
    }

    rule.content = body;
    return rule;
  }
}

const adapter = new CursorRuleAdapter();
registry.register(adapter);
export default adapter;
