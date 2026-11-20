import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, RuleDefinition, RuleScope } from "../types/index.js";

type WindsurfTrigger = "always_on" | "glob" | "manual" | "model_decision";

export class WindsurfRuleAdapter extends BaseRuleAdapter {
  readonly id = "windsurf";
  readonly name = "Windsurf";
  readonly nativeSupport = true;
  readonly configDir = ".windsurf/rules";
  override readonly command = "windsurf";

  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    return rules.map((rule) => ({
      path: `${this.configDir}/${rule.id}.md`,
      content: formatRule(rule),
      format: "md" as const,
    }));
  }

  async import(cwd?: string): Promise<RuleDefinition[]> {
    const dir = cwd ?? process.cwd();
    const rules: RuleDefinition[] = [];
    const rulesDir = resolve(dir, this.configDir);

    if (existsSync(rulesDir)) {
      const files = await readdir(rulesDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const content = await readFile(resolve(rulesDir, file), "utf-8");
        rules.push(parseRule(basename(file, ".md"), content));
      }
    }

    const legacyPath = resolve(dir, ".windsurfrules");
    if (existsSync(legacyPath)) {
      const raw = (await readFile(legacyPath, "utf-8")).replace(/\r\n/g, "\n").trim();
      if (raw.length > 0) {
        rules.push({
          id: "windsurfrules",
          name: "Windsurf Rules",
          content: raw,
          scope: { type: "always" },
        });
      }
    }

    return rules;
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
}

function triggerForScope(scope: RuleScope): WindsurfTrigger {
  switch (scope.type) {
    case "always":
      return "always_on";
    case "glob":
      return "glob";
    case "manual":
      return "manual";
    case "agent":
      return "model_decision";
  }
}

function formatRule(rule: RuleDefinition): string {
  const trigger = triggerForScope(rule.scope);
  let md = "---\n";
  md += `trigger: ${trigger}\n`;
  if (rule.description) {
    md += `description: ${rule.description}\n`;
  } else if (trigger === "model_decision") {
    md += `description: ${rule.name}\n`;
  }
  if (rule.scope.type === "glob" && rule.scope.patterns.length > 0) {
    md += `globs: ${rule.scope.patterns.join(", ")}\n`;
  }
  md += "---\n\n";
  md += `${rule.content}\n`;
  return md;
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function parseRule(id: string, raw: string): RuleDefinition {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);

  if (!match) {
    const lines = normalized.split("\n");
    let name = id;
    let contentStart = 0;
    if (lines[0]?.startsWith("# ")) {
      name = lines[0].slice(2).trim();
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

  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();

  let trigger: string | undefined;
  let description: string | undefined;
  const globs: string[] = [];
  let inGlobsList = false;

  for (const line of frontmatter.split("\n")) {
    if (inGlobsList && /^\s*-\s+/.test(line)) {
      const pattern = stripQuotes(line.replace(/^\s*-\s+/, ""));
      if (pattern) globs.push(pattern);
      continue;
    }

    inGlobsList = false;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();

    if (key === "trigger" && rawValue) {
      trigger = stripQuotes(rawValue);
    } else if (key === "description" && rawValue) {
      description = stripQuotes(rawValue);
    } else if (key === "globs") {
      if (rawValue) {
        const inline = rawValue.replace(/^\[|\]$/g, "");
        for (const item of inline.split(",")) {
          const pattern = stripQuotes(item);
          if (pattern) globs.push(pattern);
        }
      } else {
        inGlobsList = true;
      }
    }
  }

  let scope: RuleScope;
  if (trigger === "glob" || (trigger === undefined && globs.length > 0)) {
    scope = { type: "glob", patterns: globs };
  } else if (trigger === "manual") {
    scope = { type: "manual" };
  } else if (trigger === "model_decision") {
    scope = { type: "agent", agentId: "cascade" };
  } else {
    scope = { type: "always" };
  }

  const rule: RuleDefinition = {
    id,
    name: id,
    content: body,
    scope,
  };
  if (description) rule.description = description;
  return rule;
}

const adapter = new WindsurfRuleAdapter();
registry.register(adapter);
export default adapter;
