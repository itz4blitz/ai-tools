import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BaseRuleAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, RuleDefinition } from "../types/index.js";

const AGENTS_MD = "AGENTS.md";
const BEGIN_MARKER = "<!-- ai-tools:rules:start -->";
const END_MARKER = "<!-- ai-tools:rules:end -->";
const RULE_ID_RE = /^<!--\s*ai-tools:rule:([^\s]+)\s*-->$/;

export class DroidRuleAdapter extends BaseRuleAdapter {
  readonly id = "droid";
  readonly name = "Factory Droid";
  readonly nativeSupport = true;
  readonly configDir = AGENTS_MD;
  override readonly command = "droid";

  async generate(rules: RuleDefinition[]): Promise<GeneratedFile[]> {
    if (rules.length === 0) return [];
    return [
      {
        path: AGENTS_MD,
        content: `${formatManagedSection(rules)}\n`,
        format: "md",
      },
    ];
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });

      if (existsSync(fullPath)) {
        const existing = await readFile(fullPath, "utf-8");
        const merged = mergeManagedSection(existing, file.content);
        await writeFile(fullPath, merged, "utf-8");
      } else {
        await writeFile(fullPath, file.content, "utf-8");
      }
    }
  }

  async import(cwd?: string): Promise<RuleDefinition[]> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, AGENTS_MD);
    if (!existsSync(fullPath)) return [];

    const raw = (await readFile(fullPath, "utf-8")).replace(/\r\n/g, "\n");
    const beginIdx = raw.indexOf(BEGIN_MARKER);
    const endIdx = raw.indexOf(END_MARKER);

    if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
      const managedBody = raw.slice(beginIdx + BEGIN_MARKER.length, endIdx).trim();
      if (!managedBody) return [];
      return parseManagedRules(managedBody);
    }

    const trimmed = raw.trim();
    if (!trimmed) return [];
    return [
      {
        id: "agents",
        name: "AGENTS",
        content: trimmed,
        scope: { type: "always" },
      },
    ];
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, AGENTS_MD);
    if (!existsSync(fullPath)) return;

    const raw = (await readFile(fullPath, "utf-8")).replace(/\r\n/g, "\n");
    const beginIdx = raw.indexOf(BEGIN_MARKER);
    const endIdx = raw.indexOf(END_MARKER);
    if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
      return;
    }

    const before = raw.slice(0, beginIdx).trimEnd();
    const after = raw.slice(endIdx + END_MARKER.length).trimStart();
    const remaining = [before, after]
      .filter((part) => part.length > 0)
      .join("\n\n")
      .trim();

    if (!remaining) {
      await rm(fullPath);
      return;
    }

    await writeFile(fullPath, `${remaining}\n`, "utf-8");
  }
}

function formatManagedSection(rules: RuleDefinition[]): string {
  const sections = rules.map(
    (rule) => `<!-- ai-tools:rule:${rule.id} -->\n## ${rule.name}\n\n${rule.content.trim()}`,
  );
  return `${BEGIN_MARKER}\n${sections.join("\n\n")}\n${END_MARKER}`;
}

function mergeManagedSection(existingRaw: string, generatedRaw: string): string {
  const existing = existingRaw.replace(/\r\n/g, "\n");
  const generated = generatedRaw.replace(/\r\n/g, "\n").trim();

  const beginIdx = existing.indexOf(BEGIN_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx).trimEnd();
    const after = existing.slice(endIdx + END_MARKER.length).trimStart();
    const parts = [before, generated, after].filter((part) => part.length > 0);
    return `${parts.join("\n\n")}\n`;
  }

  const trimmedExisting = existing.trim();
  if (!trimmedExisting) {
    return `${generated}\n`;
  }
  return `${trimmedExisting}\n\n${generated}\n`;
}

function parseManagedRules(managedBody: string): RuleDefinition[] {
  const lines = managedBody.split("\n");
  const rules: RuleDefinition[] = [];

  let currentId: string | null = null;
  let currentName: string | null = null;
  let contentLines: string[] = [];

  const flush = () => {
    if (!currentId && !currentName && contentLines.length === 0) return;
    const content = contentLines.join("\n").trim();
    const name = currentName ?? currentId ?? "Rule";
    const id = currentId ?? slugify(name);
    rules.push({
      id,
      name,
      content,
      scope: { type: "always" },
    });
    currentId = null;
    currentName = null;
    contentLines = [];
  };

  for (const line of lines) {
    const idMatch = RULE_ID_RE.exec(line.trim());
    if (idMatch) {
      flush();
      currentId = idMatch[1] ?? null;
      continue;
    }

    if (line.startsWith("## ") && currentName === null && contentLines.every((l) => !l.trim())) {
      currentName = line.slice(3).trim();
      contentLines = [];
      continue;
    }

    if (line.startsWith("## ") && currentId === null) {
      flush();
      currentName = line.slice(3).trim();
      continue;
    }

    contentLines.push(line);
  }

  flush();
  return rules;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "rule"
  );
}

const adapter = new DroidRuleAdapter();
registry.register(adapter);
export default adapter;
