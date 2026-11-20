import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { RuleDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

const INSTRUCTIONS_SUFFIX = ".instructions.md";
const REPO_INSTRUCTIONS_PATH = ".github/copilot-instructions.md";

export class CopilotRuleAdapter extends BaseRuleAdapter {
  readonly id = "copilot";
  readonly name = "Copilot";
  readonly nativeSupport = true;
  readonly configDir = ".github/instructions";
  override readonly command = "copilot";

  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    return rules.map((rule) => ({
      path: `${this.configDir}/${rule.id}${INSTRUCTIONS_SUFFIX}`,
      content: formatRule(rule),
      format: "md" as const,
    }));
  }

  async import(cwd?: string): Promise<RuleDefinition[]> {
    const dir = cwd ?? process.cwd();
    const rules: RuleDefinition[] = [];

    const repoInstructionsPath = resolve(dir, REPO_INSTRUCTIONS_PATH);
    if (existsSync(repoInstructionsPath)) {
      const content = await readFile(repoInstructionsPath, "utf-8");
      rules.push(parseRepoInstructions(content));
    }

    const rulesDir = resolve(dir, this.configDir);
    if (existsSync(rulesDir)) {
      const entries = await readdir(rulesDir);
      for (const entry of entries) {
        if (!entry.endsWith(INSTRUCTIONS_SUFFIX)) continue;
        const content = await readFile(resolve(rulesDir, entry), "utf-8");
        const id = basename(entry, INSTRUCTIONS_SUFFIX);
        rules.push(parseRule(id, content));
      }
    }

    return rules;
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const rulesDir = resolve(dir, this.configDir);
    if (!existsSync(rulesDir)) return;

    const entries = await readdir(rulesDir);
    for (const entry of entries) {
      if (!entry.endsWith(INSTRUCTIONS_SUFFIX)) continue;
      await rm(resolve(rulesDir, entry), { force: true });
    }

    const remaining = await readdir(rulesDir);
    if (remaining.length === 0) {
      await rm(rulesDir, { recursive: true, force: true });
    }
  }
}

function formatRule(rule: RuleDefinition): string {
  const fmLines: string[] = [];

  if (rule.scope.type === "always") {
    fmLines.push('applyTo: "**"');
  } else if (rule.scope.type === "glob" && rule.scope.patterns.length > 0) {
    fmLines.push(`applyTo: "${rule.scope.patterns.join(",")}"`);
  }

  if (rule.description) {
    fmLines.push(`description: ${rule.description}`);
  }

  let md = "";
  if (fmLines.length > 0) {
    md += `---\n${fmLines.join("\n")}\n---\n\n`;
  }

  md += `# ${rule.name}\n\n${rule.content}\n`;
  return md;
}

function parseRule(id: string, raw: string): RuleDefinition {
  const rule: RuleDefinition = { id, name: id, content: "", scope: { type: "always" } };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw.trim());

  let body = raw.trim();
  if (match) {
    const fm = match[1] ?? "";
    body = (match[2] ?? "").trim();

    let applyTo: string | undefined;
    for (const line of fm.split(/\r?\n/)) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = stripQuotes(line.slice(colonIdx + 1).trim());
      if (key === "applyTo") {
        applyTo = value;
      } else if (key === "description" && value) {
        rule.description = value;
      }
    }

    if (applyTo === undefined || applyTo === "") {
      rule.scope = { type: "manual" };
    } else if (applyTo === "**" || applyTo === "*") {
      rule.scope = { type: "always" };
    } else {
      const patterns = applyTo
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      rule.scope = patterns.length > 0 ? { type: "glob", patterns } : { type: "always" };
    }
  }

  const parsedBody = extractHeadingAndBody(id, body);
  rule.name = parsedBody.name;
  rule.content = parsedBody.content;
  return rule;
}

function parseRepoInstructions(raw: string): RuleDefinition {
  const parsedBody = extractHeadingAndBody("copilot-instructions", raw.trim());
  return {
    id: "copilot-instructions",
    name: parsedBody.name,
    content: parsedBody.content,
    scope: { type: "always" },
  };
}

function extractHeadingAndBody(
  fallbackName: string,
  body: string,
): { name: string; content: string } {
  const lines = body.split(/\r?\n/);
  let name = fallbackName;
  let start = 0;

  if (lines[0]?.startsWith("# ")) {
    name = lines[0].slice(2).trim();
    start = 1;
    if (lines[start]?.trim() === "") start++;
  }

  return {
    name,
    content: lines.slice(start).join("\n").trim(),
  };
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

const adapter = new CopilotRuleAdapter();
registry.register(adapter);
export default adapter;
