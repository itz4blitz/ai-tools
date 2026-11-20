import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, RuleDefinition } from "../types/index.js";

export const MANAGED_START = "<!-- ai-tools:rules:start -->";
export const MANAGED_END = "<!-- ai-tools:rules:end -->";
const RULE_ID_PREFIX = "<!-- ai-tools:rule:id=";
const RULE_ID_SUFFIX = " -->";

export type CodexRuleLayer = "project" | "user";

export class CodexRuleAdapter extends BaseRuleAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  readonly nativeSupport = true;
  readonly configDir = "AGENTS.md";
  readonly command = "codex";

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (
      existsSync(resolve(dir, "AGENTS.md")) ||
      existsSync(resolve(dir, "AGENTS.override.md")) ||
      existsSync(resolve(dir, ".codex"))
    ) {
      return true;
    }
    return this.commandExists(this.command);
  }

  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    if (rules.length === 0) return [];

    const rendered = rules.map((rule) => formatManagedRule(rule)).join("\n\n");
    const content = `${MANAGED_START}\n${rendered}\n${MANAGED_END}\n`;

    return [
      {
        path: "AGENTS.md",
        content,
        format: "md",
      },
    ];
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });

      if (
        existsSync(fullPath) &&
        file.content.includes(MANAGED_START) &&
        file.content.includes(MANAGED_END)
      ) {
        const existing = await readFile(fullPath, "utf-8");
        const merged = mergeManagedSection(existing, file.content);
        await writeFile(fullPath, merged, "utf-8");
        continue;
      }

      await writeFile(fullPath, file.content, "utf-8");
    }
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, "AGENTS.md");
    if (!existsSync(fullPath)) return;

    const existing = await readFile(fullPath, "utf-8");
    const stripped = stripManagedSection(existing);
    if (stripped === null) {
      // No managed section found; preserve manual AGENTS.md untouched.
      return;
    }

    if (stripped.trim() === "") {
      await rm(fullPath);
      return;
    }

    await writeFile(fullPath, `${stripped}\n`, "utf-8");
  }

  async import(cwd?: string, layer: CodexRuleLayer = "project"): Promise<RuleDefinition[]> {
    if (layer === "user") {
      return this.importUser(cwd);
    }

    const dir = cwd ?? process.cwd();
    return importFromDirectory(dir, [
      {
        file: "AGENTS.override.md",
        defaultId: "agents-override",
        defaultName: "AGENTS.override.md",
      },
      { file: "AGENTS.md", defaultId: "agents", defaultName: "AGENTS.md" },
    ]);
  }

  async importUser(userCodexDir?: string): Promise<RuleDefinition[]> {
    const dir = userCodexDir ?? resolveCodexHome();
    return importFromDirectory(dir, [
      {
        file: "AGENTS.override.md",
        defaultId: "codex-user-agents-override",
        defaultName: "Codex User AGENTS.override.md",
      },
      {
        file: "AGENTS.md",
        defaultId: "codex-user-agents",
        defaultName: "Codex User AGENTS.md",
      },
    ]);
  }
}

function resolveCodexHome(): string {
  const envHome = process.env.CODEX_HOME?.trim();
  return envHome ? envHome : join(homedir(), ".codex");
}

function formatManagedRule(rule: RuleDefinition): string {
  const header = `${RULE_ID_PREFIX}${rule.id}${RULE_ID_SUFFIX}\n## ${rule.name}`;
  return `${header}\n\n${rule.content.trim()}`;
}

function mergeManagedSection(existingRaw: string, generatedBlock: string): string {
  const existing = existingRaw.replace(/\r\n?/g, "\n");
  const block = generatedBlock.replace(/\r\n?/g, "\n").trimEnd();

  const startIdx = existing.indexOf(MANAGED_START);
  const endIdx = existing.indexOf(MANAGED_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + MANAGED_END.length);
    const combined = `${before}${block}${after}`;
    return combined.endsWith("\n") ? combined : `${combined}\n`;
  }

  const trimmedExisting = existing.trimEnd();
  if (trimmedExisting === "") {
    return `${block}\n`;
  }
  return `${trimmedExisting}\n\n${block}\n`;
}

function stripManagedSection(existingRaw: string): string | null {
  const existing = existingRaw.replace(/\r\n?/g, "\n");
  const startIdx = existing.indexOf(MANAGED_START);
  const endIdx = existing.indexOf(MANAGED_END);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return null;
  }

  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + MANAGED_END.length).trimStart();

  if (!before && !after) return "";
  if (!before) return after.trimEnd();
  if (!after) return before;
  return `${before}\n\n${after.trimEnd()}`;
}

async function importFromDirectory(
  dir: string,
  candidates: Array<{ file: string; defaultId: string; defaultName: string }>,
): Promise<RuleDefinition[]> {
  const rules: RuleDefinition[] = [];
  const seenIds = new Set<string>();

  for (const candidate of candidates) {
    const fullPath = resolve(dir, candidate.file);
    if (!existsSync(fullPath)) continue;

    const raw = await readFile(fullPath, "utf-8");
    const parsed = parseAgentsMarkdown(raw, candidate.defaultId, candidate.defaultName);
    for (const rule of parsed) {
      if (seenIds.has(rule.id)) continue;
      seenIds.add(rule.id);
      rules.push(rule);
    }
  }

  return rules;
}

function parseAgentsMarkdown(
  raw: string,
  defaultId: string,
  defaultName: string,
): RuleDefinition[] {
  const normalized = raw.replace(/\r\n?/g, "\n");
  const rules: RuleDefinition[] = [];

  const startIdx = normalized.indexOf(MANAGED_START);
  const endIdx = normalized.indexOf(MANAGED_END);

  let manualContent = normalized;

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const managedBody = normalized.slice(startIdx + MANAGED_START.length, endIdx).trim();
    rules.push(...parseManagedRules(managedBody));

    const before = normalized.slice(0, startIdx).trimEnd();
    const after = normalized.slice(endIdx + MANAGED_END.length).trimStart();
    manualContent = [before, after].filter(Boolean).join("\n\n");
  }

  const trimmedManual = manualContent.trim();
  if (trimmedManual.length > 0) {
    rules.push(parseManualMarkdown(defaultId, defaultName, trimmedManual));
  }

  return rules;
}

function parseManagedRules(managedBody: string): RuleDefinition[] {
  if (!managedBody) return [];

  const markerRegex = /<!-- ai-tools:rule:id=([^\s>]+)\s*-->/g;
  const matches = [...managedBody.matchAll(markerRegex)];
  if (matches.length === 0) {
    return [parseManualMarkdown("agents-managed", "AGENTS.md", managedBody)];
  }

  const rules: RuleDefinition[] = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    if (!current || !current[1]) continue;
    const id = current[1].trim();
    const bodyStart = (current.index ?? 0) + current[0].length;
    const nextMatch = matches[i + 1];
    const bodyEnd = nextMatch ? (nextMatch.index ?? managedBody.length) : managedBody.length;
    const section = managedBody.slice(bodyStart, bodyEnd).trim();

    const lines = section.split("\n");
    let name = id;
    let contentStart = 0;
    if (lines[0]?.startsWith("## ")) {
      name = lines[0].slice(3).trim();
      contentStart = 1;
      if (lines[contentStart]?.trim() === "") contentStart++;
    } else if (lines[0]?.startsWith("# ")) {
      name = lines[0].slice(2).trim();
      contentStart = 1;
      if (lines[contentStart]?.trim() === "") contentStart++;
    }

    const content = lines.slice(contentStart).join("\n").trim();
    rules.push({
      id,
      name,
      content,
      scope: { type: "always" },
    });
  }

  return rules;
}

function parseManualMarkdown(id: string, defaultName: string, raw: string): RuleDefinition {
  const lines = raw.trim().split("\n");
  let name = defaultName;
  let contentStart = 0;

  if (lines[0]?.startsWith("# ")) {
    name = lines[0].slice(2).trim();
    contentStart = 1;
    if (lines[contentStart]?.trim() === "") contentStart++;
  }

  const content = lines.slice(contentStart).join("\n").trim();
  return {
    id,
    name,
    content,
    scope: { type: "always" },
  };
}

const adapter = new CodexRuleAdapter();
registry.register(adapter);
export default adapter;
