import { BaseAgentAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { AgentDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type RooGroupEntry = string | [string, Record<string, unknown>];

type RooCustomMode = {
  slug: string;
  name: string;
  description?: string;
  whenToUse?: string;
  roleDefinition: string;
  groups?: RooGroupEntry[];
  [key: string]: unknown;
};

type ParsedRoomodes = {
  topLevel: Record<string, unknown>;
  customModes: RooCustomMode[];
};

const DEFAULT_GROUPS = ["read", "edit", "command"];

class RooCodeAgentAdapter extends BaseAgentAdapter {
  readonly id = "roo-code";
  readonly name = "Roo Code";
  readonly nativeSupport = true;
  readonly configDir = ".roo";
  override readonly installStrategy = "transform" as const;

  async generate(agents: AgentDefinition[]): Promise<GeneratedFile[]> {
    if (agents.length === 0) return [];

    const customModes: RooCustomMode[] = agents.map((agent) => {
      const mode: RooCustomMode = {
        slug: agent.id,
        name: agent.name,
        roleDefinition: agent.instructions,
        groups: agent.tools ?? [...DEFAULT_GROUPS],
      };
      if (agent.description) {
        mode.description = agent.description;
        mode.whenToUse = agent.description;
      }
      return mode;
    });

    return [
      {
        path: ".roomodes",
        content: JSON.stringify({ customModes }, null, 2) + "\n",
        format: "json" as const,
      },
    ];
  }

  async import(cwd?: string): Promise<AgentDefinition[]> {
    const dir = cwd ?? process.cwd();
    const filePath = resolve(dir, ".roomodes");
    if (!existsSync(filePath)) return [];

    const raw = await readFile(filePath, "utf-8");
    const { customModes } = parseRoomodes(raw);

    return customModes
      .filter((mode) => typeof mode.slug === "string" && mode.slug.length > 0)
      .map((mode) => {
        const agent: AgentDefinition = {
          id: mode.slug,
          name: typeof mode.name === "string" && mode.name.length > 0 ? mode.name : mode.slug,
          instructions: typeof mode.roleDefinition === "string" ? mode.roleDefinition : "",
        };
        const description = nonEmptyString(mode.description) ?? nonEmptyString(mode.whenToUse);
        if (description) agent.description = description;
        const tools = normalizeGroups(mode.groups);
        if (tools) agent.tools = tools;
        return agent;
      });
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });

      if (file.path === ".roomodes" && existsSync(fullPath)) {
        const existingRaw = await readFile(fullPath, "utf-8");
        const merged = mergeRoomodes(existingRaw, file.content);
        await writeFile(fullPath, merged, "utf-8");
      } else {
        await writeFile(fullPath, file.content, "utf-8");
      }
    }
  }

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    return existsSync(resolve(dir, ".roomodes")) || existsSync(resolve(dir, this.configDir));
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const filePath = resolve(dir, ".roomodes");
    if (existsSync(filePath)) {
      await rm(filePath, { force: true });
    }
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeGroups(groups: unknown): string[] | undefined {
  if (!Array.isArray(groups)) return undefined;
  const normalized: string[] = [];
  for (const entry of groups) {
    if (typeof entry === "string" && entry.length > 0) {
      normalized.push(entry);
    } else if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].length > 0) {
      normalized.push(entry[0]);
    }
  }
  return normalized;
}

function mergeRoomodes(existingRaw: string, generatedRaw: string): string {
  const existing = parseRoomodes(existingRaw);
  const incoming = parseRoomodes(generatedRaw);

  const incomingBySlug = new Map<string, RooCustomMode>();
  for (const mode of incoming.customModes) {
    if (typeof mode.slug === "string" && mode.slug.length > 0) {
      incomingBySlug.set(mode.slug, mode);
    }
  }

  const seenSlugs = new Set<string>();
  const mergedModes: RooCustomMode[] = [];

  for (const existingMode of existing.customModes) {
    const replacement = incomingBySlug.get(existingMode.slug);
    if (replacement) {
      mergedModes.push({ ...existingMode, ...replacement });
      seenSlugs.add(existingMode.slug);
    } else {
      mergedModes.push(existingMode);
      seenSlugs.add(existingMode.slug);
    }
  }

  for (const mode of incoming.customModes) {
    if (!seenSlugs.has(mode.slug)) {
      mergedModes.push(mode);
      seenSlugs.add(mode.slug);
    }
  }

  return JSON.stringify({ ...existing.topLevel, customModes: mergedModes }, null, 2) + "\n";
}

function parseRoomodes(raw: string): ParsedRoomodes {
  const trimmed = raw.trim();
  if (!trimmed) return { topLevel: {}, customModes: [] };

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const modes = Array.isArray(parsed.customModes)
        ? (parsed.customModes.filter(
            (m): m is RooCustomMode => m !== null && typeof m === "object" && !Array.isArray(m),
          ) as RooCustomMode[])
        : [];
      const topLevel = { ...parsed };
      delete topLevel.customModes;
      return { topLevel, customModes: modes };
    }
  } catch {
    // Fall through to YAML parser
  }

  return { topLevel: {}, customModes: parseRoomodesYaml(raw) };
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function stripInlineYamlComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && value[i - 1] !== "\\") {
      inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trimEnd();
}

function parseFlowGroups(raw: string): RooGroupEntry[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed as RooGroupEntry[];
  } catch {
    // Handle unquoted YAML flow arrays like [read, edit, ["command", { description: "Run" }]]
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];

  const items: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && inner[i - 1] !== "\\") {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 0) {
        items.push(inner.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  const tail = inner.slice(start).trim();
  if (tail) items.push(tail);

  const groups: RooGroupEntry[] = [];
  for (const item of items) {
    if (item.startsWith("[") && item.endsWith("]")) {
      const tupleItems = parseFlowGroups(item);
      if (typeof tupleItems[0] === "string") {
        groups.push([tupleItems[0], {}]);
      }
    } else if (item.length > 0 && !item.startsWith("{")) {
      groups.push(unquoteYamlScalar(item));
    }
  }
  return groups;
}

function indentOf(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === " ") count++;
  return count;
}

function parseRoomodesYaml(raw: string): RooCustomMode[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const modes: RooCustomMode[] = [];

  let i = 0;
  let customModesIndent = -1;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    if (/^customModes\s*:/.test(trimmed)) {
      customModesIndent = indentOf(line);
      i++;
      break;
    }
    i++;
  }

  if (customModesIndent === -1) return [];

  let current: RooCustomMode | null = null;
  let itemIndent = -1;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const indent = indentOf(line);
    if (indent <= customModesIndent && !trimmed.startsWith("-")) {
      break;
    }

    const isNewMode = trimmed.startsWith("- ") && (itemIndent === -1 || indent === itemIndent);

    if (isNewMode) {
      if (current) modes.push(current);
      itemIndent = indent;
      current = { slug: "", name: "", roleDefinition: "" };

      const rest = trimmed.slice(2).trim();
      if (rest) {
        const parsed = parseKeyValueLine(rest, lines, i, indent + 2);
        applyModeField(current, parsed.key, parsed.value);
        i = parsed.nextIndex;
        continue;
      }
      i++;
      continue;
    }

    if (!current) {
      i++;
      continue;
    }

    const fieldIndent = indent;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const afterColon = stripInlineYamlComment(trimmed.slice(colonIdx + 1)).trim();

    if (key === "groups") {
      if (afterColon.startsWith("[")) {
        current.groups = parseFlowGroups(afterColon);
        i++;
      } else {
        const result = parseYamlGroupsBlock(lines, i + 1, fieldIndent);
        current.groups = result.groups;
        i = result.nextIndex;
      }
      continue;
    }

    const parsed = parseKeyValueLine(trimmed, lines, i, fieldIndent);
    applyModeField(current, parsed.key, parsed.value);
    i = parsed.nextIndex;
  }

  if (current) modes.push(current);
  return modes.filter((m) => m.slug.length > 0);
}

function parseKeyValueLine(
  trimmedLine: string,
  lines: string[],
  lineIndex: number,
  baseIndent: number,
): { key: string; value: string; nextIndex: number } {
  const colonIdx = trimmedLine.indexOf(":");
  if (colonIdx === -1) {
    return { key: "", value: "", nextIndex: lineIndex + 1 };
  }

  const key = trimmedLine.slice(0, colonIdx).trim();
  const afterColon = stripInlineYamlComment(trimmedLine.slice(colonIdx + 1)).trim();

  if (/^[|>][+-]?$/.test(afterColon)) {
    const folded = afterColon.startsWith(">");
    const stripTrailing = afterColon.endsWith("-");
    const keepTrailing = afterColon.endsWith("+");

    const blockLines: string[] = [];
    let j = lineIndex + 1;
    let contentIndent = -1;

    while (j < lines.length) {
      const nextLine = lines[j] ?? "";
      if (nextLine.trim() === "") {
        blockLines.push("");
        j++;
        continue;
      }
      const nextIndent = indentOf(nextLine);
      if (nextIndent <= baseIndent) break;
      if (contentIndent === -1) contentIndent = nextIndent;
      blockLines.push(nextLine.slice(Math.min(contentIndent, nextIndent)));
      j++;
    }

    if (!keepTrailing) {
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
        blockLines.pop();
      }
    }

    let text = folded ? foldYamlBlock(blockLines) : blockLines.join("\n");
    if (!stripTrailing && !keepTrailing && text.length > 0) {
      text = text.trimEnd();
    }
    return { key, value: text, nextIndex: j };
  }

  return { key, value: unquoteYamlScalar(afterColon), nextIndex: lineIndex + 1 };
}

function foldYamlBlock(lines: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "") {
      parts.push("\n");
    } else if (i > 0 && lines[i - 1] !== "") {
      parts.push(" " + line);
    } else {
      parts.push(line);
    }
  }
  return parts.join("");
}

function parseYamlGroupsBlock(
  lines: string[],
  startIndex: number,
  groupsKeyIndent: number,
): { groups: RooGroupEntry[]; nextIndex: number } {
  const groups: RooGroupEntry[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const indent = indentOf(line);
    if (indent <= groupsKeyIndent) break;

    if (!trimmed.startsWith("-")) {
      i++;
      continue;
    }

    const itemContent = stripInlineYamlComment(trimmed.slice(1)).trim();
    if (itemContent.startsWith("- ")) {
      // Nested sequence tuple: `- - edit` followed by indented `- fileRegex: ...`
      const groupName = unquoteYamlScalar(itemContent.slice(2).trim());
      const options: Record<string, unknown> = {};
      i++;
      while (i < lines.length) {
        const subLine = lines[i] ?? "";
        const subTrimmed = subLine.trim();
        if (!subTrimmed || subTrimmed.startsWith("#")) {
          i++;
          continue;
        }
        const subIndent = indentOf(subLine);
        if (subIndent <= indent) break;
        const optLine = subTrimmed.startsWith("- ") ? subTrimmed.slice(2).trim() : subTrimmed;
        const colonIdx = optLine.indexOf(":");
        if (colonIdx !== -1) {
          const optKey = optLine.slice(0, colonIdx).trim();
          const optVal = unquoteYamlScalar(stripInlineYamlComment(optLine.slice(colonIdx + 1)));
          options[optKey] = optVal;
        }
        i++;
      }
      if (groupName) {
        groups.push([groupName, options]);
      }
      continue;
    }

    if (itemContent.startsWith("[") && itemContent.endsWith("]")) {
      const tuple = parseFlowGroups(itemContent);
      if (typeof tuple[0] === "string") {
        groups.push([tuple[0], {}]);
      }
      i++;
      continue;
    }

    if (itemContent) {
      groups.push(unquoteYamlScalar(itemContent));
    }
    i++;
  }

  return { groups, nextIndex: i };
}

function applyModeField(mode: RooCustomMode, key: string, value: string): void {
  if (!key) return;
  if (key === "slug") mode.slug = value;
  else if (key === "name") mode.name = value;
  else if (key === "roleDefinition") mode.roleDefinition = value;
  else if (key === "description") mode.description = value;
  else if (key === "whenToUse") mode.whenToUse = value;
  else mode[key] = value;
}

const adapter = new RooCodeAgentAdapter();
registry.register(adapter);

export { RooCodeAgentAdapter };
export default adapter;
