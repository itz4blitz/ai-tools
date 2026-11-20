import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { GeneratedFile, RuleDefinition, RuleScope } from "../types/index.js";
import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";

const MANAGED_START = "<!-- ai-tools:rules:start -->";
const MANAGED_END = "<!-- ai-tools:rules:end -->";
const RULE_MARKER_RE = /^<!-- ai-tools:rule id="([^"]+)"(?: globs="([^"]*)")? -->$/;

function normalizeNewlines(raw: string): string {
  return raw.replace(/\r\n/g, "\n");
}

function extractFrontmatter(raw: string): {
  frontmatter: string | null;
  globs: string[];
  body: string;
} {
  const normalized = normalizeNewlines(raw);
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    return { frontmatter: null, globs: [], body: normalized };
  }

  const fmContent = match[1] ?? "";
  const body = match[2] ?? "";
  const globs: string[] = [];
  let inGlobs = false;

  for (const line of fmContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("globs:")) {
      const rest = trimmed.slice(6).trim();
      if (rest.startsWith("[") && rest.endsWith("]")) {
        inGlobs = false;
        for (const item of rest.slice(1, -1).split(",")) {
          const cleaned = item.trim().replace(/^["']|["']$/g, "");
          if (cleaned) globs.push(cleaned);
        }
      } else if (rest) {
        inGlobs = false;
        const cleaned = rest.replace(/^["']|["']$/g, "");
        if (cleaned) globs.push(cleaned);
      } else {
        inGlobs = true;
      }
    } else if (inGlobs && trimmed.startsWith("- ")) {
      const pattern = trimmed
        .slice(2)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (pattern) globs.push(pattern);
    } else if (/^[a-zA-Z0-9_-]+\s*:/.test(trimmed)) {
      inGlobs = false;
    }
  }

  return { frontmatter: `---\n${fmContent}\n---`, globs, body };
}

function buildFrontmatter(globs: string[]): string {
  if (globs.length === 0) return "";
  const lines = ["---", "globs:"];
  for (const pattern of globs) {
    lines.push(`  - ${JSON.stringify(pattern)}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n`;
}

function formatRuleBlock(rule: RuleDefinition): string {
  const globsAttr =
    rule.scope.type === "glob" && rule.scope.patterns.length > 0
      ? ` globs="${rule.scope.patterns.join(",")}"`
      : "";
  const parts: string[] = [`<!-- ai-tools:rule id="${rule.id}"${globsAttr} -->`, `## ${rule.name}`];
  if (rule.description) {
    parts.push("", rule.description);
  }
  parts.push("", rule.content.trim());
  return parts.join("\n");
}

function buildManagedSection(rules: RuleDefinition[]): string {
  const blocks = rules.map((rule) => formatRuleBlock(rule));
  return `${MANAGED_START}\n${blocks.join("\n\n")}\n${MANAGED_END}`;
}

function collectFileGlobs(rules: RuleDefinition[]): string[] {
  // Only attach file-level globs frontmatter when every rule is glob-scoped;
  // otherwise an `always` rule in root AGENTS.md would be over-scoped.
  if (
    rules.length === 0 ||
    !rules.every((rule) => rule.scope.type === "glob" && rule.scope.patterns.length > 0)
  ) {
    return [];
  }

  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.scope.type === "glob") {
      for (const pattern of rule.scope.patterns) {
        if (pattern) seen.add(pattern);
      }
    }
  }
  return [...seen];
}

function parseManagedRules(section: string): RuleDefinition[] {
  const lines = normalizeNewlines(section).split("\n");
  const rules: RuleDefinition[] = [];

  let currentId: string | null = null;
  let currentGlobs: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (!currentId) return;
    const rawBlock = buffer.join("\n").trim();
    const blockLines = rawBlock.split("\n");
    let name = currentId;
    let contentStart = 0;

    if (blockLines[0]?.startsWith("## ")) {
      name = blockLines[0].slice(3).trim();
      contentStart = 1;
      if (blockLines[contentStart]?.trim() === "") contentStart++;
    }

    const content = blockLines.slice(contentStart).join("\n").trim();
    const scope: RuleScope =
      currentGlobs.length > 0 ? { type: "glob", patterns: currentGlobs } : { type: "always" };

    rules.push({
      id: currentId,
      name,
      content,
      scope,
    });
  };

  for (const line of lines) {
    const marker = RULE_MARKER_RE.exec(line.trim());
    if (marker) {
      flush();
      currentId = marker[1] ?? null;
      currentGlobs = marker[2]
        ? marker[2]
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean)
        : [];
      buffer = [];
    } else if (currentId !== null) {
      buffer.push(line);
    }
  }
  flush();

  return rules;
}

export class AmpRuleAdapter extends BaseRuleAdapter {
  readonly id = "amp";
  readonly name = "Amp";
  readonly nativeSupport = true;
  readonly configDir = "AGENTS.md";
  readonly command = "amp";

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (
      existsSync(resolve(dir, "AGENTS.md")) ||
      existsSync(resolve(dir, "AGENT.md")) ||
      existsSync(resolve(dir, ".amp"))
    ) {
      return true;
    }
    return this.commandExists(this.command);
  }

  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    if (rules.length === 0) return [];
    const globs = collectFileGlobs(rules);
    const frontmatter = buildFrontmatter(globs);
    const managed = buildManagedSection(rules);
    return [
      {
        path: "AGENTS.md",
        content: `${frontmatter}${managed}\n`,
        format: "md",
      },
    ];
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });

      if (!existsSync(fullPath)) {
        await writeFile(fullPath, file.content, "utf-8");
        continue;
      }

      const existingRaw = normalizeNewlines(await readFile(fullPath, "utf-8"));
      const existingParsed = extractFrontmatter(existingRaw);
      const generatedParsed = extractFrontmatter(file.content);
      const generatedBody = generatedParsed.body.trim();

      const startIdx = existingParsed.body.indexOf(MANAGED_START);
      const endIdx = existingParsed.body.indexOf(MANAGED_END);

      let merged: string;
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const before = existingParsed.body.slice(0, startIdx);
        const after = existingParsed.body.slice(endIdx + MANAGED_END.length);
        const hasManualProse = Boolean(before.trim() || after.trim());

        if (!hasManualProse) {
          // Purely managed file: replace frontmatter + managed section together.
          merged = file.content;
        } else {
          const updatedBody = `${before}${generatedBody}${after}`.replace(/^\n+/, "");
          merged = existingParsed.frontmatter
            ? `${existingParsed.frontmatter}\n\n${updatedBody}`
            : updatedBody;
        }
      } else {
        const userBody = existingParsed.body.trim();
        const combinedBody = userBody ? `${userBody}\n\n${generatedBody}` : generatedBody;
        // Preserve existing frontmatter; never attach file-level globs over manual prose.
        const frontmatter = userBody ? existingParsed.frontmatter : generatedParsed.frontmatter;
        merged = frontmatter ? `${frontmatter}\n\n${combinedBody}\n` : `${combinedBody}\n`;
      }

      if (!merged.endsWith("\n")) {
        merged += "\n";
      }
      await writeFile(fullPath, merged, "utf-8");
    }
  }

  async import(cwd?: string): Promise<RuleDefinition[]> {
    const dir = cwd ?? process.cwd();
    const agentsPath = resolve(dir, "AGENTS.md");
    const fallbackPath = resolve(dir, "AGENT.md");
    const targetPath = existsSync(agentsPath)
      ? agentsPath
      : existsSync(fallbackPath)
        ? fallbackPath
        : null;

    if (!targetPath) return [];

    const raw = await readFile(targetPath, "utf-8");
    const { globs, body } = extractFrontmatter(raw);
    const trimmedBody = body.trim();
    if (!trimmedBody) return [];

    const startIdx = trimmedBody.indexOf(MANAGED_START);
    const endIdx = trimmedBody.indexOf(MANAGED_END);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const inner = trimmedBody.slice(startIdx + MANAGED_START.length, endIdx).trim();
      const parsed = parseManagedRules(inner);
      if (parsed.length > 0) return parsed;
    }

    const lines = trimmedBody.split("\n");
    let name = "AGENTS";
    let contentStart = 0;
    if (lines[0]?.startsWith("# ")) {
      name = lines[0].slice(2).trim();
      contentStart = 1;
      if (lines[contentStart]?.trim() === "") contentStart++;
    }

    const scope: RuleScope =
      globs.length > 0 ? { type: "glob", patterns: globs } : { type: "always" };

    return [
      {
        id: "agents",
        name,
        content: lines.slice(contentStart).join("\n").trim(),
        scope,
      },
    ];
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, "AGENTS.md");
    if (!existsSync(fullPath)) return;

    const raw = normalizeNewlines(await readFile(fullPath, "utf-8"));
    const { frontmatter, body } = extractFrontmatter(raw);
    const startIdx = body.indexOf(MANAGED_START);
    const endIdx = body.indexOf(MANAGED_END);
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      return;
    }

    const before = body.slice(0, startIdx).trimEnd();
    const after = body.slice(endIdx + MANAGED_END.length).trimStart();
    const remainingBody = [before, after].filter(Boolean).join("\n\n").trim();

    if (!remainingBody) {
      await rm(fullPath);
      return;
    }

    const output = frontmatter ? `${frontmatter}\n\n${remainingBody}\n` : `${remainingBody}\n`;
    await writeFile(fullPath, output, "utf-8");
  }
}

const adapter = new AmpRuleAdapter();
registry.register(adapter);
export default adapter;
