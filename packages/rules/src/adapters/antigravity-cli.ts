import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { GeneratedFile, RuleDefinition } from "../types/index.js";
import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";

export class AntigravityCliRuleAdapter extends BaseRuleAdapter {
  readonly id = "antigravity-cli";
  readonly name = "Antigravity CLI";
  readonly nativeSupport = true;
  readonly configDir = ".agents/rules";
  override readonly command = "agy";

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configDir))) return true;
    if (existsSync(join(homedir(), ".gemini", "antigravity-cli", "settings.json"))) return true;
    return this.commandExists(this.command);
  }

  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    return rules.map((rule) => ({
      path: `${this.configDir}/${rule.id}.md`,
      content: formatRule(rule),
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
      rules.push(parseRule(id, content));
    }

    return rules;
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const rulesDir = resolve(dir, this.configDir);
    if (!existsSync(rulesDir)) return;
    await rm(rulesDir, { recursive: true, force: true });
  }
}

function formatRule(rule: RuleDefinition): string {
  const trigger = rule.scope.type === "always" ? "always_on" : "model_decision";
  const lines = ["---", `trigger: ${trigger}`];
  const description = rule.description ?? (trigger === "model_decision" ? rule.name : undefined);
  if (description) {
    lines.push(`description: ${description}`);
  }
  lines.push("---", "", `# ${rule.name}`, "", rule.content, "");
  return lines.join("\n");
}

function parseRule(id: string, rawInput: string): RuleDefinition {
  const raw = rawInput.replace(/\r\n/g, "\n");
  let trigger: string | undefined;
  let description: string | undefined;
  let body = raw;

  if (raw.startsWith("---\n")) {
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx !== -1) {
      const fm = raw.slice(4, endIdx);
      body = raw.slice(endIdx + 4);
      for (const line of fm.split("\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const value = stripQuotes(line.slice(colon + 1).trim());
        if (key === "trigger") trigger = value;
        if (key === "description") description = value;
      }
    }
  }

  const lines = body.trim().split("\n");
  let name = id;
  let contentStart = 0;

  if (lines[0]?.startsWith("# ")) {
    name = lines[0].slice(2).trim();
    contentStart = 1;
    if (lines[contentStart]?.trim() === "") contentStart++;
  }

  const content = lines.slice(contentStart).join("\n").trim();
  const scope =
    trigger === "model_decision" ? ({ type: "manual" } as const) : ({ type: "always" } as const);

  return {
    id,
    name,
    ...(description ? { description } : {}),
    content,
    scope,
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

const adapter = new AntigravityCliRuleAdapter();
registry.register(adapter);
export default adapter;
