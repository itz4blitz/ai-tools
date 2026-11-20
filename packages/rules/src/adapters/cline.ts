import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { RuleDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

/**
 * Cline rule adapter.
 *
 * Targets `.clinerules/*.md`, supporting:
 * - Conditional path-scoped rules via YAML frontmatter (`paths: [...]`)
 * - Graceful import and migration of legacy single-file `.clinerules`
 * - Safe uninstall that removes `.clinerules/*.md` without touching
 *   `.clinerules/hooks/` or `.clinerules/workflows/`.
 */
export class ClineRuleAdapter extends BaseRuleAdapter {
  readonly id = "cline";
  readonly name = "Cline";
  readonly nativeSupport = true;
  readonly configDir = ".clinerules";
  readonly command = "cline";

  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    return rules.map((rule) => ({
      path: `${this.configDir}/${rule.id}.md`,
      content: formatRule(rule),
      format: "md" as const,
    }));
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const rulesRoot = resolve(dir, this.configDir);

    // Gracefully migrate legacy single-file `.clinerules` into `.clinerules/legacy.md`
    if (existsSync(rulesRoot)) {
      const rootStat = await stat(rulesRoot);
      if (rootStat.isFile()) {
        const legacyContent = await readFile(rulesRoot, "utf-8");
        await rm(rulesRoot);
        await mkdir(rulesRoot, { recursive: true });
        const hasLegacyCollision = files.some(
          (file) => resolve(dir, file.path) === resolve(rulesRoot, "legacy.md"),
        );
        if (!hasLegacyCollision && legacyContent.trim().length > 0) {
          await writeFile(resolve(rulesRoot, "legacy.md"), legacyContent, "utf-8");
        }
      }
    }

    for (const file of files) {
      const fullPath = resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.content, "utf-8");
    }
  }

  async import(cwd?: string): Promise<RuleDefinition[]> {
    const dir = cwd ?? process.cwd();
    const rulesPath = resolve(dir, this.configDir);
    if (!existsSync(rulesPath)) return [];

    const pathStat = await stat(rulesPath);
    if (pathStat.isFile()) {
      const raw = await readFile(rulesPath, "utf-8");
      if (!raw.trim()) return [];
      return [parseRule("clinerules", raw)];
    }

    if (!pathStat.isDirectory()) return [];

    const entries = await readdir(rulesPath, { withFileTypes: true });
    const rules: RuleDefinition[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const content = await readFile(resolve(rulesPath, entry.name), "utf-8");
      const id = basename(entry.name, ".md");
      rules.push(parseRule(id, content));
    }

    return rules;
  }

  /**
   * Remove `.clinerules/*.md` rule files without touching sibling subdirectories
   * such as `.clinerules/hooks/` or `.clinerules/workflows/`.
   */
  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const rulesPath = resolve(dir, this.configDir);
    if (!existsSync(rulesPath)) return;

    const pathStat = await stat(rulesPath);
    if (pathStat.isFile()) {
      await rm(rulesPath);
      return;
    }

    if (!pathStat.isDirectory()) return;

    const entries = await readdir(rulesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        await rm(resolve(rulesPath, entry.name));
      }
    }
  }
}

function formatRule(rule: RuleDefinition): string {
  let md = "";
  if (rule.scope.type === "glob" && rule.scope.patterns.length > 0) {
    md += "---\npaths:\n";
    for (const pattern of rule.scope.patterns) {
      md += `  - ${JSON.stringify(pattern)}\n`;
    }
    md += "---\n\n";
  }
  md += `# ${rule.name}\n\n${rule.content}\n`;
  return md;
}

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

function parseRule(id: string, raw: string): RuleDefinition {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  let body = normalized;
  const paths: string[] = [];

  const fmMatch = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (fmMatch) {
    const frontmatter = fmMatch[1] ?? "";
    body = (fmMatch[2] ?? "").trim();

    let inPaths = false;
    for (const line of frontmatter.split("\n")) {
      const trimmed = line.trim();
      if (/^paths\s*:/.test(trimmed)) {
        const rest = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        if (rest.startsWith("[") && rest.endsWith("]")) {
          const inner = rest.slice(1, -1).trim();
          if (inner) {
            for (const item of inner.split(",")) {
              const cleaned = unquote(item);
              if (cleaned) paths.push(cleaned);
            }
          }
          inPaths = false;
        } else {
          inPaths = true;
        }
        continue;
      }

      if (inPaths) {
        if (trimmed.startsWith("- ")) {
          const cleaned = unquote(trimmed.slice(2));
          if (cleaned) paths.push(cleaned);
        } else if (trimmed.length > 0 && !line.startsWith(" ") && !line.startsWith("\t")) {
          inPaths = false;
        }
      }
    }
  }

  const lines = body.split("\n");
  let name = id;
  let contentStart = 0;

  if (lines[0]?.startsWith("# ")) {
    name = lines[0].slice(2).trim();
    contentStart = 1;
    if (lines[contentStart]?.trim() === "") contentStart++;
  }

  const content = lines.slice(contentStart).join("\n").trim();
  const scope =
    paths.length > 0 ? ({ type: "glob", patterns: paths } as const) : ({ type: "always" } as const);

  return { id, name, content, scope };
}

const adapter = new ClineRuleAdapter();
registry.register(adapter);
export default adapter;
