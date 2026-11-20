import { BaseAgentAdapter, registry } from "./index.js";
import type { AgentDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export class CodexAgentAdapter extends BaseAgentAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  readonly nativeSupport = true;
  readonly configDir = ".codex/agents";
  readonly userConfigDir = ".codex/agents";
  override readonly installStrategy = "transform" as const;
  override readonly command = "codex";

  async generate(agents: AgentDefinition[]): Promise<GeneratedFile[]> {
    return agents.map((agent) => ({
      path: `${this.configDir}/${agent.id}.toml`,
      content: formatAgent(agent),
      format: "toml" as const,
    }));
  }

  async import(cwd?: string): Promise<AgentDefinition[]> {
    const dir = cwd ?? process.cwd();
    return importAgentsFromDir(resolve(dir, this.configDir));
  }

  async importUser(userHomeDir?: string): Promise<AgentDefinition[]> {
    const agentsDir = userHomeDir
      ? resolve(userHomeDir, this.userConfigDir)
      : join(process.env.CODEX_HOME || join(homedir(), ".codex"), "agents");
    return importAgentsFromDir(agentsDir);
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const agentsDir = resolve(dir, this.configDir);
    if (!existsSync(agentsDir)) return;

    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".toml")) {
        await rm(resolve(agentsDir, entry.name));
      }
    }

    const remaining = await readdir(agentsDir);
    if (remaining.length === 0) {
      await rm(agentsDir, { recursive: true, force: true });
    }
  }
}

async function importAgentsFromDir(agentsDir: string): Promise<AgentDefinition[]> {
  if (!existsSync(agentsDir)) return [];

  const files = await readdir(agentsDir);
  const agents: AgentDefinition[] = [];

  for (const file of files) {
    if (!file.endsWith(".toml")) continue;
    const content = await readFile(resolve(agentsDir, file), "utf-8");
    agents.push(parseAgent(basename(file, ".toml"), content));
  }

  return agents;
}

function formatAgent(agent: AgentDefinition): string {
  const lines = [
    `name = ${tomlString(agent.name)}`,
    `description = ${tomlString(agent.description ?? agent.name)}`,
    `developer_instructions = ${tomlString(agent.instructions)}`,
  ];

  if (agent.model) {
    lines.push(`model = ${tomlString(agent.model)}`);
  }

  return `${lines.join("\n")}\n`;
}

function parseAgent(id: string, raw: string): AgentDefinition {
  const fields = parseTopLevelStrings(raw);
  return {
    id,
    name: fields.name ?? id,
    description: fields.description,
    instructions: fields.developer_instructions ?? "",
    model: fields.model,
  };
}

/**
 * Parse top-level TOML string assignments before any `[table]` section.
 * Supports basic strings `"..."`, literal strings `'...'`, multiline basic
 * strings `"""..."""`, multiline literal strings `'''...'''`, and inline `#` comments.
 */
function parseTopLevelStrings(raw: string): Record<string, string> {
  const src = raw.replace(/\r\n?/g, "\n");
  const fields: Record<string, string> = {};
  let pos = 0;
  const len = src.length;

  const skipSpaces = () => {
    while (pos < len && (src[pos] === " " || src[pos] === "\t")) pos++;
  };

  const skipToEndOfLine = () => {
    while (pos < len && src[pos] !== "\n") pos++;
    if (pos < len && src[pos] === "\n") pos++;
  };

  while (pos < len) {
    skipSpaces();
    if (pos >= len) break;

    const ch = src[pos];
    if (ch === undefined) break;
    if (ch === "\n") {
      pos++;
      continue;
    }
    if (ch === "#") {
      skipToEndOfLine();
      continue;
    }
    // Stop parsing top-level keys as soon as a [table] or [[array]] header begins.
    if (ch === "[") {
      break;
    }

    // Parse key
    const keyStart = pos;
    let key = "";
    if (ch === '"' || ch === "'") {
      const parsedKey = parseSingleLineString(src, pos, ch);
      if (!parsedKey) {
        skipToEndOfLine();
        continue;
      }
      key = parsedKey.value;
      pos = parsedKey.nextPos;
    } else {
      while (pos < len) {
        const keyChar = src[pos];
        if (!keyChar || !/[A-Za-z0-9_.-]/.test(keyChar)) break;
        pos++;
      }
      key = src.slice(keyStart, pos);
    }

    skipSpaces();
    if (!key || src[pos] !== "=") {
      skipToEndOfLine();
      continue;
    }
    pos++; // consume '='
    skipSpaces();

    if (pos >= len) break;

    const valueChar = src[pos];
    if (src.startsWith('"""', pos)) {
      const parsed = parseMultilineBasicString(src, pos + 3);
      if (parsed) {
        fields[key] = parsed.value;
        pos = parsed.nextPos;
        skipToEndOfLine();
      } else {
        break;
      }
    } else if (src.startsWith("'''", pos)) {
      const parsed = parseMultilineLiteralString(src, pos + 3);
      if (parsed) {
        fields[key] = parsed.value;
        pos = parsed.nextPos;
        skipToEndOfLine();
      } else {
        break;
      }
    } else if (valueChar === '"' || valueChar === "'") {
      const parsed = parseSingleLineString(src, pos, valueChar);
      if (parsed) {
        fields[key] = parsed.value;
        pos = parsed.nextPos;
      }
      skipToEndOfLine();
    } else {
      // Non-string value (boolean, number, array, etc.) — skip line.
      skipToEndOfLine();
    }
  }

  return fields;
}

function parseSingleLineString(
  src: string,
  startPos: number,
  quote: string,
): { value: string; nextPos: number } | null {
  let pos = startPos + 1;
  const len = src.length;

  if (quote === "'") {
    const start = pos;
    while (pos < len && src[pos] !== "'" && src[pos] !== "\n") pos++;
    if (pos >= len || src[pos] !== "'") return null;
    return { value: src.slice(start, pos), nextPos: pos + 1 };
  }

  let out = "";
  while (pos < len && src[pos] !== "\n") {
    const ch = src[pos];
    if (ch === undefined) break;
    if (ch === '"') {
      return { value: out, nextPos: pos + 1 };
    }
    if (ch === "\\") {
      const escaped = decodeTomlEscape(src, pos + 1);
      if (!escaped) return null;
      out += escaped.value;
      pos = escaped.nextPos;
      continue;
    }
    out += ch;
    pos++;
  }
  return null;
}

function parseMultilineBasicString(
  src: string,
  startPos: number,
): { value: string; nextPos: number } | null {
  let pos = startPos;
  const len = src.length;
  // TOML trims a newline immediately following the opening delimiter.
  if (src[pos] === "\n") pos++;

  let out = "";
  while (pos < len) {
    if (src.startsWith('"""', pos)) {
      // Handle up to 2 extra quotes before closing delimiter (e.g., """"" -> 2 quotes + close)
      let quoteCount = 0;
      while (pos + quoteCount < len && src[pos + quoteCount] === '"') quoteCount++;
      if (quoteCount >= 3 && quoteCount <= 5) {
        out += '"'.repeat(quoteCount - 3);
        return { value: out, nextPos: pos + quoteCount };
      }
      return { value: out, nextPos: pos + 3 };
    }

    const ch = src[pos];
    if (ch === undefined) break;
    if (ch === "\\") {
      // Line-ending backslash trims trailing whitespace and newlines.
      let lookahead = pos + 1;
      while (lookahead < len && (src[lookahead] === " " || src[lookahead] === "\t")) {
        lookahead++;
      }
      if (src[lookahead] === "\n") {
        pos = lookahead + 1;
        while (pos < len && (src[pos] === " " || src[pos] === "\t" || src[pos] === "\n")) {
          pos++;
        }
        continue;
      }

      const escaped = decodeTomlEscape(src, pos + 1);
      if (!escaped) return null;
      out += escaped.value;
      pos = escaped.nextPos;
      continue;
    }

    out += ch;
    pos++;
  }
  return null;
}

function parseMultilineLiteralString(
  src: string,
  startPos: number,
): { value: string; nextPos: number } | null {
  let pos = startPos;
  const len = src.length;
  // TOML trims a newline immediately following the opening delimiter.
  if (src[pos] === "\n") pos++;

  const closeIdx = src.indexOf("'''", pos);
  if (closeIdx === -1) return null;

  let quoteCount = 0;
  while (closeIdx + quoteCount < len && src[closeIdx + quoteCount] === "'") quoteCount++;
  const extraQuotes = quoteCount > 3 && quoteCount <= 5 ? "'".repeat(quoteCount - 3) : "";

  return {
    value: src.slice(pos, closeIdx) + extraQuotes,
    nextPos: closeIdx + Math.min(quoteCount, 5),
  };
}

function decodeTomlEscape(src: string, pos: number): { value: string; nextPos: number } | null {
  const ch = src[pos];
  if (ch === undefined) return null;
  switch (ch) {
    case "b":
      return { value: "\b", nextPos: pos + 1 };
    case "t":
      return { value: "\t", nextPos: pos + 1 };
    case "n":
      return { value: "\n", nextPos: pos + 1 };
    case "f":
      return { value: "\f", nextPos: pos + 1 };
    case "r":
      return { value: "\r", nextPos: pos + 1 };
    case '"':
      return { value: '"', nextPos: pos + 1 };
    case "\\":
      return { value: "\\", nextPos: pos + 1 };
    case "u": {
      const hex = src.slice(pos + 1, pos + 5);
      if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
        return { value: String.fromCodePoint(parseInt(hex, 16)), nextPos: pos + 5 };
      }
      return null;
    }
    case "U": {
      const hex = src.slice(pos + 1, pos + 9);
      if (/^[0-9A-Fa-f]{8}$/.test(hex)) {
        return { value: String.fromCodePoint(parseInt(hex, 16)), nextPos: pos + 9 };
      }
      return null;
    }
    default:
      return { value: ch, nextPos: pos + 1 };
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

const adapter = new CodexAgentAdapter();
registry.register(adapter);
export default adapter;
