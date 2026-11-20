import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { RuleDefinition, RuleScope, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

const RULE_EXTENSIONS = new Set([".md", ".txt"]);
const MODE_RULES_PREFIX = "rules-";

export class RooCodeRuleAdapter extends BaseRuleAdapter {
  readonly id = "roo-code";
  readonly name = "Roo Code";
  readonly nativeSupport = true;
  readonly configDir = ".roo/rules";

  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    return rules.map((rule) => {
      const targetDir =
        rule.scope.type === "agent"
          ? `.roo/${MODE_RULES_PREFIX}${rule.scope.agentId}`
          : this.configDir;
      return {
        path: `${targetDir}/${rule.id}.md`,
        content: `# ${rule.name}\n\n${rule.content}\n`,
        format: "md" as const,
      };
    });
  }

  async import(cwd?: string): Promise<RuleDefinition[]> {
    const dir = cwd ?? process.cwd();
    const rooDir = resolve(dir, ".roo");
    if (!existsSync(rooDir)) return [];

    const rules: RuleDefinition[] = [];
    const entries = await readdir(rooDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      let scope: RuleScope | null = null;
      if (entry.name === "rules") {
        scope = { type: "always" };
      } else if (
        entry.name.startsWith(MODE_RULES_PREFIX) &&
        entry.name.length > MODE_RULES_PREFIX.length
      ) {
        scope = { type: "agent", agentId: entry.name.slice(MODE_RULES_PREFIX.length) };
      }

      if (!scope) continue;
      const folderRules = await readRulesFromDir(resolve(rooDir, entry.name), scope);
      rules.push(...folderRules);
    }

    return rules;
  }

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configDir))) return true;

    const rooDir = resolve(dir, ".roo");
    if (!existsSync(rooDir)) return false;

    const entries = await readdir(rooDir, { withFileTypes: true });
    return entries.some(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith(MODE_RULES_PREFIX) &&
        entry.name.length > MODE_RULES_PREFIX.length,
    );
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const rooDir = resolve(dir, ".roo");
    if (!existsSync(rooDir)) return;

    const entries = await readdir(rooDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (
        entry.name === "rules" ||
        (entry.name.startsWith(MODE_RULES_PREFIX) && entry.name.length > MODE_RULES_PREFIX.length)
      ) {
        await rm(resolve(rooDir, entry.name), { recursive: true, force: true });
      }
    }
  }
}

async function readRulesFromDir(rootDir: string, scope: RuleScope): Promise<RuleDefinition[]> {
  const entries = await readdir(rootDir, { recursive: true, withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!RULE_EXTENSIONS.has(ext)) continue;
    files.push(join(entry.parentPath, entry.name));
  }

  files.sort((a, b) => a.localeCompare(b));

  const rules: RuleDefinition[] = [];
  for (const fullPath of files) {
    const raw = await readFile(fullPath, "utf-8");
    const rel = relative(rootDir, fullPath).split(sep).join("/");
    const ext = extname(rel);
    const id = ext ? rel.slice(0, -ext.length) : rel;
    rules.push(parseRule(id, raw, scope));
  }

  return rules;
}

function parseRule(id: string, raw: string, scope: RuleScope): RuleDefinition {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n");
  let name = id;
  let contentStart = 0;

  if (lines[0]?.startsWith("# ")) {
    name = lines[0].slice(2).trim();
    contentStart = 1;
    if (lines[contentStart]?.trim() === "") contentStart++;
  }

  const content = lines.slice(contentStart).join("\n").trim();
  return { id, name, content, scope };
}

const adapter = new RooCodeRuleAdapter();
registry.register(adapter);
export default adapter;
