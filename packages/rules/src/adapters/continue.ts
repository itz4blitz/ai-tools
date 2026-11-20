import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, RuleDefinition, RuleScope } from "../types/index.js";

export class ContinueRuleAdapter extends BaseRuleAdapter {
  readonly id = "continue";
  readonly name = "Continue";
  readonly nativeSupport = true;
  readonly configDir = ".continue/rules";
  readonly command = "cn";

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

    const entries = await readdir(rulesDir);
    const rules: RuleDefinition[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const content = await readFile(resolve(rulesDir, entry), "utf-8");
      rules.push(this.parseRule(basename(entry, ".md"), content));
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
    const lines: string[] = ["---"];
    lines.push(`name: ${formatYamlScalar(rule.name)}`);

    const description =
      rule.description ??
      (rule.scope.type === "agent" ? `Agent rule for ${rule.scope.agentId}` : undefined);
    if (description) {
      lines.push(`description: ${formatYamlScalar(description)}`);
    }

    if (rule.scope.type === "always") {
      lines.push("alwaysApply: true");
    } else if (rule.scope.type === "glob") {
      lines.push("alwaysApply: false");
      if (rule.scope.patterns.length > 0) {
        lines.push("globs:");
        for (const pattern of rule.scope.patterns) {
          lines.push(`  - ${JSON.stringify(pattern)}`);
        }
      }
    } else if (rule.scope.type === "manual") {
      lines.push("alwaysApply: false");
    }
    // For scope.type === "agent", omit alwaysApply (Continue agent-requested mode uses description).

    lines.push("---");
    return `${lines.join("\n")}\n\n${rule.content}\n`;
  }

  private parseRule(id: string, raw: string): RuleDefinition {
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized.trimStart());

    if (!match) {
      return parsePlainMarkdownRule(id, normalized);
    }

    const fm = match[1] ?? "";
    const body = (match[2] ?? "").trim();

    let name = id;
    let description: string | undefined;
    let alwaysApply: boolean | undefined;
    const globs: string[] = [];
    let inGlobs = false;

    for (const rawLine of fm.split("\n")) {
      const line = rawLine.trimEnd();
      const trimmed = line.trim();

      if (inGlobs && trimmed.startsWith("- ")) {
        const pattern = unquoteYamlScalar(trimmed.slice(2).trim());
        if (pattern) globs.push(pattern);
        continue;
      }

      if (trimmed.length === 0) continue;
      inGlobs = false;

      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();

      if (key === "name" && value) {
        name = unquoteYamlScalar(value);
      } else if (key === "description" && value) {
        description = unquoteYamlScalar(value);
      } else if (key === "alwaysApply") {
        if (value === "true") alwaysApply = true;
        else if (value === "false") alwaysApply = false;
      } else if (key === "globs") {
        if (!value) {
          inGlobs = true;
        } else {
          globs.push(...parseInlineGlobs(value));
        }
      }
    }

    const scope = resolveScope(globs, alwaysApply, description);
    const rule: RuleDefinition = { id, name, content: body, scope };
    if (description !== undefined) {
      rule.description = description;
    }
    return rule;
  }
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

function parseInlineGlobs(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((item) => unquoteYamlScalar(item.trim()))
      .filter((item) => item.length > 0);
  }
  const single = unquoteYamlScalar(trimmed);
  return single ? [single] : [];
}

function resolveScope(
  globs: string[],
  alwaysApply: boolean | undefined,
  description: string | undefined,
): RuleScope {
  if (globs.length > 0) {
    return { type: "glob", patterns: globs };
  }
  if (alwaysApply === true) {
    return { type: "always" };
  }
  if (alwaysApply === false) {
    return { type: "manual" };
  }
  if (description) {
    return { type: "agent", agentId: "default" };
  }
  return { type: "always" };
}

function parsePlainMarkdownRule(id: string, normalized: string): RuleDefinition {
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
    scope: { type: "always" },
  };
}

const adapter = new ContinueRuleAdapter();
registry.register(adapter);
export default adapter;
