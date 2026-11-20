import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { RuleDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const SECTION_START = "<!-- ai-tools:rules:start -->";
const SECTION_END = "<!-- ai-tools:rules:end -->";
const RULE_MARKER_RE = /^<!--\s*ai-tools:rule:([^\s>]+)\s*-->$/;

export class GeminiCliRuleAdapter extends BaseRuleAdapter {
  readonly id = "gemini-cli";
  readonly name = "Gemini CLI";
  readonly nativeSupport = true;
  readonly configDir = "GEMINI.md";
  readonly userConfigPath = join(homedir(), ".gemini", "GEMINI.md");
  readonly command = "gemini";

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, this.configDir)) || existsSync(resolve(dir, ".gemini"))) {
      return true;
    }
    return this.commandExists(this.command);
  }

  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    if (rules.length === 0) return [];
    return [
      {
        path: this.configDir,
        content: formatManagedSection(rules),
        format: "md",
      },
    ];
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = isAbsolute(file.path) ? file.path : resolve(dir, file.path);
      await installManagedMarkdown(fullPath, file.content);
    }
  }

  async installUser(files: GeneratedFile[]): Promise<void> {
    for (const file of files) {
      await installManagedMarkdown(this.userConfigPath, file.content);
    }
  }

  async import(cwd?: string): Promise<RuleDefinition[]> {
    const dir = cwd ?? process.cwd();
    return readGeminiRulesFile(resolve(dir, this.configDir));
  }

  async importUser(): Promise<RuleDefinition[]> {
    return readGeminiRulesFile(this.userConfigPath);
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    await uninstallManagedMarkdown(resolve(dir, this.configDir));
  }

  async uninstallUser(): Promise<void> {
    await uninstallManagedMarkdown(this.userConfigPath);
  }
}

function formatManagedSection(rules: RuleDefinition[]): string {
  const blocks = rules.map((rule) => {
    const lines: string[] = [`<!-- ai-tools:rule:${rule.id} -->`, `## ${rule.name}`];
    if (rule.description) {
      lines.push("", `_${rule.description}_`);
    }
    lines.push("", rule.content.trim());
    return lines.join("\n");
  });
  return `${SECTION_START}\n${blocks.join("\n\n")}\n${SECTION_END}\n`;
}

async function installManagedMarkdown(fullPath: string, managedBlock: string): Promise<void> {
  await mkdir(dirname(fullPath), { recursive: true });
  const normalizedBlock = managedBlock.replace(/\r\n/g, "\n").trimEnd();

  if (!existsSync(fullPath)) {
    await writeFile(fullPath, `${normalizedBlock}\n`, "utf-8");
    return;
  }

  const existing = (await readFile(fullPath, "utf-8")).replace(/\r\n/g, "\n");
  const startIdx = existing.indexOf(SECTION_START);
  const endIdx = existing.indexOf(SECTION_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx >= startIdx) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + SECTION_END.length);
    const next = `${before}${normalizedBlock}${after}`;
    await writeFile(fullPath, next.endsWith("\n") ? next : `${next}\n`, "utf-8");
    return;
  }

  const trimmed = existing.trimEnd();
  const next = trimmed.length > 0 ? `${trimmed}\n\n${normalizedBlock}\n` : `${normalizedBlock}\n`;
  await writeFile(fullPath, next, "utf-8");
}

async function uninstallManagedMarkdown(fullPath: string): Promise<void> {
  if (!existsSync(fullPath)) return;
  const existing = (await readFile(fullPath, "utf-8")).replace(/\r\n/g, "\n");
  const startIdx = existing.indexOf(SECTION_START);
  const endIdx = existing.indexOf(SECTION_END);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return;
  }

  const before = existing.slice(0, startIdx).trimEnd();
  const after = existing.slice(endIdx + SECTION_END.length).trimStart();
  const remaining = [before, after]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();

  if (remaining.length === 0) {
    await rm(fullPath);
  } else {
    await writeFile(fullPath, `${remaining}\n`, "utf-8");
  }
}

async function readGeminiRulesFile(fullPath: string): Promise<RuleDefinition[]> {
  if (!existsSync(fullPath)) return [];
  const raw = (await readFile(fullPath, "utf-8")).replace(/\r\n/g, "\n").trim();
  if (!raw) return [];

  const startIdx = raw.indexOf(SECTION_START);
  const endIdx = raw.indexOf(SECTION_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const inner = raw.slice(startIdx + SECTION_START.length, endIdx).trim();
    const parsed = parseManagedRules(inner);
    if (parsed.length > 0) return parsed;
  }

  const lines = raw.split("\n");
  let name = "GEMINI.md";
  let contentStart = 0;
  if (lines[0]?.startsWith("# ")) {
    name = lines[0].slice(2).trim() || name;
    contentStart = 1;
    if (lines[contentStart]?.trim() === "") contentStart++;
  }
  const content = lines.slice(contentStart).join("\n").trim();
  if (!content) return [];

  return [{ id: "gemini-md", name, content, scope: { type: "always" } }];
}

function parseManagedRules(inner: string): RuleDefinition[] {
  if (!inner) return [];
  const lines = inner.split("\n");
  const rules: RuleDefinition[] = [];
  let currentId: string | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentId) return;
    const blockLines = [...currentLines];
    while (blockLines.length > 0 && blockLines[0]?.trim() === "") blockLines.shift();
    while (blockLines.length > 0 && blockLines[blockLines.length - 1]?.trim() === "") {
      blockLines.pop();
    }

    let name = currentId;
    if (blockLines[0]?.startsWith("## ")) {
      const heading = blockLines.shift();
      name = heading ? heading.slice(3).trim() || currentId : currentId;
      while (blockLines.length > 0 && blockLines[0]?.trim() === "") blockLines.shift();
    }

    let description: string | undefined;
    const firstLine = blockLines[0]?.trim();
    if (firstLine && firstLine.startsWith("_") && firstLine.endsWith("_") && firstLine.length > 2) {
      description = firstLine.slice(1, -1);
      blockLines.shift();
      while (blockLines.length > 0 && blockLines[0]?.trim() === "") blockLines.shift();
    }

    const content = blockLines.join("\n").trim();
    rules.push({
      id: currentId,
      name,
      ...(description ? { description } : {}),
      content,
      scope: { type: "always" },
    });
  };

  for (const line of lines) {
    const match = RULE_MARKER_RE.exec(line.trim());
    if (match) {
      flush();
      currentId = match[1] ?? null;
      currentLines = [];
    } else if (currentId !== null) {
      currentLines.push(line);
    }
  }
  flush();

  return rules;
}

const adapter = new GeminiCliRuleAdapter();
registry.register(adapter);
export default adapter;
