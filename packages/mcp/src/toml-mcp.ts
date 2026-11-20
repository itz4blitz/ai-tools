import type { MCPServerDefinition, MCPTransport } from "./types/index.js";

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function tomlString(value: string): string {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")
    .replaceAll("\b", "\\b")
    .replaceAll("\f", "\\f");
  return `"${escaped}"`;
}

export function tomlKey(id: string): string {
  if (BARE_KEY.test(id)) return id;
  return tomlString(id);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function isUrlTransport(
  transport: MCPTransport,
): transport is Extract<MCPTransport, { url: string }> {
  return transport.type === "sse" || transport.type === "http";
}

export type EncodeMcpTomlOptions = {
  /** Nested table name for HTTP headers. Grok uses `headers`; Codex uses `http_headers`. */
  headerTable?: "headers" | "http_headers";
};

export function encodeMcpToml(
  servers: MCPServerDefinition[],
  options: EncodeMcpTomlOptions = {},
): string {
  const headerTable = options.headerTable ?? "headers";
  const chunks: string[] = [];
  for (const server of servers) {
    const key = tomlKey(server.id);
    const lines: string[] = [`[mcp_servers.${key}]`];
    if (server.transport.type === "stdio") {
      lines.push(`command = ${tomlString(server.transport.command)}`);
      if (server.transport.args && server.transport.args.length > 0) {
        lines.push(`args = ${tomlArray(server.transport.args)}`);
      }
      if (server.enabled === false) lines.push("enabled = false");
      const env = server.transport.env ?? {};
      const envKeys = Object.keys(env);
      if (envKeys.length > 0) {
        lines.push("");
        lines.push(`[mcp_servers.${key}.env]`);
        for (const envKey of envKeys) {
          const envValue = env[envKey];
          if (envValue === undefined) continue;
          lines.push(`${tomlKey(envKey)} = ${tomlString(envValue)}`);
        }
      }
    } else if (isUrlTransport(server.transport)) {
      lines.push(`url = ${tomlString(server.transport.url)}`);
      if (server.enabled === false) lines.push("enabled = false");
      const headers = server.transport.headers ?? {};
      const headerKeys = Object.keys(headers);
      if (headerKeys.length > 0) {
        lines.push("");
        lines.push(`[mcp_servers.${key}.${headerTable}]`);
        for (const headerKey of headerKeys) {
          const headerValue = headers[headerKey];
          if (headerValue === undefined) continue;
          lines.push(`${tomlKey(headerKey)} = ${tomlString(headerValue)}`);
        }
      }
    }
    chunks.push(lines.join("\n"));
  }
  return chunks.length === 0 ? "" : `${chunks.join("\n\n")}\n`;
}

type Table = Record<string, string | boolean | string[]>;

function unescapeTomlBasicString(inner: string): string {
  return inner.replace(/\\(\\|"|n|r|t|b|f)/g, (_match, ch: string) => {
    switch (ch) {
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        return `\\${ch}`;
    }
  });
}

function stripInlineComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inDouble) {
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
    } else if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "#") {
      return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

function unquoteTomlString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return unescapeTomlBasicString(trimmed.slice(1, -1));
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scanBasicString(input: string, start: number): { value: string; next: number } {
  let i = start + 1;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') {
      return {
        value: unescapeTomlBasicString(input.slice(start + 1, i)),
        next: i + 1,
      };
    }
    i++;
  }
  return {
    value: unescapeTomlBasicString(input.slice(start + 1)),
    next: input.length,
  };
}

function scanLiteralString(input: string, start: number): { value: string; next: number } {
  const end = input.indexOf("'", start + 1);
  if (end === -1) {
    return { value: input.slice(start + 1), next: input.length };
  }
  return { value: input.slice(start + 1, end), next: end + 1 };
}

function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

function parseHeaderSegments(headerContent: string): string[] {
  const segments: string[] = [];
  let i = 0;
  const len = headerContent.length;

  while (i < len) {
    while (i < len && isWhitespace(headerContent[i])) i++;
    if (i >= len) break;

    const ch = headerContent[i];
    if (ch === '"') {
      const scanned = scanBasicString(headerContent, i);
      segments.push(scanned.value);
      i = scanned.next;
    } else if (ch === "'") {
      const scanned = scanLiteralString(headerContent, i);
      segments.push(scanned.value);
      i = scanned.next;
    } else {
      const start = i;
      while (i < len && headerContent[i] !== "." && !isWhitespace(headerContent[i])) i++;
      segments.push(headerContent.slice(start, i));
    }

    while (i < len && isWhitespace(headerContent[i])) i++;
    if (i < len && headerContent[i] === ".") {
      i++;
    }
  }

  return segments;
}

type ParsedTableHeader = {
  inner: string;
  isArrayTable: boolean;
};

function extractTableHeader(rawLine: string): ParsedTableHeader | null {
  const line = stripInlineComment(rawLine).trim();
  if (line.startsWith("[[") && line.endsWith("]]")) {
    const inner = line.slice(2, -2).trim();
    return inner.length > 0 ? { inner, isArrayTable: true } : null;
  }
  if (line.startsWith("[") && line.endsWith("]")) {
    const inner = line.slice(1, -1).trim();
    return inner.length > 0 ? { inner, isArrayTable: false } : null;
  }
  return null;
}

function splitKeyValue(line: string): [string, string] | null {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inDouble) {
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
    } else if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "=") {
      return [line.slice(0, i), line.slice(i + 1)];
    }
  }
  return null;
}

function bracketDepthDelta(raw: string): number {
  let depth = 0;
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inDouble) {
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        inDouble = false;
      }
    } else if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
    }
  }
  return depth;
}

function parseTomlArray(raw: string): string[] {
  const inner = raw.slice(1, -1);
  const items: string[] = [];
  let i = 0;
  const len = inner.length;

  while (i < len) {
    while (i < len && (isWhitespace(inner[i]) || inner[i] === ",")) i++;
    if (i >= len) break;

    const ch = inner[i];
    if (ch === '"') {
      const scanned = scanBasicString(inner, i);
      items.push(scanned.value);
      i = scanned.next;
    } else if (ch === "'") {
      const scanned = scanLiteralString(inner, i);
      items.push(scanned.value);
      i = scanned.next;
    } else {
      const start = i;
      while (i < len && inner[i] !== ",") i++;
      const token = inner.slice(start, i).trim();
      if (token.length > 0) items.push(token);
    }
  }

  return items;
}

function parseTomlValue(raw: string): string | boolean | string[] {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    return parseTomlArray(value);
  }
  return unquoteTomlString(value);
}

function parseInlineTable(raw: string): Record<string, string> | undefined {
  const value = raw.trim();
  if (!value.startsWith("{") || !value.endsWith("}")) return undefined;
  const inner = value.slice(1, -1);
  const out: Record<string, string> = {};
  let i = 0;
  const len = inner.length;

  while (i < len) {
    while (i < len && (isWhitespace(inner[i]) || inner[i] === ",")) i++;
    if (i >= len) break;

    let key: string;
    if (inner[i] === '"') {
      const scanned = scanBasicString(inner, i);
      key = scanned.value;
      i = scanned.next;
    } else if (inner[i] === "'") {
      const scanned = scanLiteralString(inner, i);
      key = scanned.value;
      i = scanned.next;
    } else {
      const start = i;
      while (i < len && inner[i] !== "=" && inner[i] !== "," && !isWhitespace(inner[i])) i++;
      key = inner.slice(start, i).trim();
    }

    while (i < len && isWhitespace(inner[i])) i++;
    if (i >= len || inner[i] !== "=") break;
    i++; // skip '='
    while (i < len && isWhitespace(inner[i])) i++;
    if (i >= len) break;

    let val: string | boolean | string[];
    if (inner[i] === '"') {
      const scanned = scanBasicString(inner, i);
      val = scanned.value;
      i = scanned.next;
    } else if (inner[i] === "'") {
      const scanned = scanLiteralString(inner, i);
      val = scanned.value;
      i = scanned.next;
    } else {
      const start = i;
      while (i < len && inner[i] !== ",") i++;
      val = parseTomlValue(inner.slice(start, i));
    }

    if (typeof val === "string") {
      out[key] = val;
    }
  }

  return out;
}

type ServerBucket = {
  main: Table;
  env: Table;
  headers: Table;
};

export function parseMcpToml(source: string): MCPServerDefinition[] {
  const buckets = new Map<string, ServerBucket>();
  let currentSegments: string[] | null = null;

  const getBucket = (id: string): ServerBucket => {
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { main: {}, env: {}, headers: {} };
      buckets.set(id, bucket);
    }
    return bucket;
  };

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const cleaned = stripInlineComment(rawLine).trim();
    if (cleaned === "") continue;

    const header = extractTableHeader(cleaned);
    if (header !== null) {
      if (header.isArrayTable) {
        currentSegments = null;
        continue;
      }
      const segments = parseHeaderSegments(header.inner);
      currentSegments = segments;
      if (segments[0] === "mcp_servers" && segments.length >= 2 && segments[1] !== undefined) {
        getBucket(segments[1]);
      }
      continue;
    }

    if (!currentSegments || currentSegments[0] !== "mcp_servers" || currentSegments.length < 2) {
      continue;
    }

    const kv = splitKeyValue(cleaned);
    if (!kv) continue;
    const key = unquoteTomlString(kv[0]);
    let rawValue = kv[1].trim();

    if (rawValue.startsWith("[")) {
      let depth = bracketDepthDelta(rawValue);
      while (depth > 0 && i + 1 < lines.length) {
        i++;
        const nextLine = lines[i];
        if (nextLine === undefined) break;
        const nextPart = stripInlineComment(nextLine).trim();
        if (nextPart === "") continue;
        rawValue += ` ${nextPart}`;
        depth += bracketDepthDelta(nextPart);
      }
    }

    const serverId = currentSegments[1];
    if (serverId === undefined) continue;
    const bucket = getBucket(serverId);
    const subtable = currentSegments.length === 3 ? currentSegments[2] : undefined;

    if (currentSegments.length === 2) {
      if (key === "env" || key === "headers" || key === "http_headers") {
        const inline = parseInlineTable(rawValue);
        if (inline) {
          const target = key === "env" ? bucket.env : bucket.headers;
          for (const [inlineKey, inlineValue] of Object.entries(inline)) {
            target[inlineKey] = inlineValue;
          }
          continue;
        }
      }
      bucket.main[key] = parseTomlValue(rawValue);
    } else if (subtable === "env") {
      bucket.env[key] = parseTomlValue(rawValue);
    } else if (subtable === "headers" || subtable === "http_headers") {
      bucket.headers[key] = parseTomlValue(rawValue);
    }
  }

  const servers: MCPServerDefinition[] = [];
  for (const [id, bucket] of buckets) {
    const table = bucket.main;
    const command = typeof table.command === "string" ? table.command : undefined;
    const url = typeof table.url === "string" ? table.url : undefined;
    const enabled = table.enabled === false ? false : undefined;
    if (command) {
      const args = Array.isArray(table.args) ? table.args : undefined;
      const env = stringRecord(bucket.env);
      const transport: Extract<MCPTransport, { type: "stdio" }> = { type: "stdio", command };
      if (args) transport.args = args;
      if (Object.keys(env).length > 0) transport.env = env;
      const def: MCPServerDefinition = { id, name: id, transport };
      if (enabled === false) def.enabled = false;
      servers.push(def);
    } else if (url) {
      const headers = stringRecord(bucket.headers);
      const transport: Extract<MCPTransport, { type: "http" }> = { type: "http", url };
      if (Object.keys(headers).length > 0) transport.headers = headers;
      const def: MCPServerDefinition = { id, name: id, transport };
      if (enabled === false) def.enabled = false;
      servers.push(def);
    }
  }
  return servers;
}

function stringRecord(table: Table): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(table)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function stripTomlTablesWhere(source: string, shouldSkip: (segments: string[]) => boolean): string {
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  let pendingComments: string[] = [];
  let sawBlankWhileSkipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const header = extractTableHeader(trimmed);
    if (header !== null) {
      const segments = parseHeaderSegments(header.inner);
      const nextSkip = header.isArrayTable ? false : shouldSkip(segments);
      if (!nextSkip && pendingComments.length > 0) {
        if (kept.length > 0 && kept[kept.length - 1]?.trim() !== "") {
          kept.push("");
        }
        kept.push(...pendingComments);
      }
      pendingComments = [];
      sawBlankWhileSkipping = false;
      skipping = nextSkip;
      if (!skipping) kept.push(line);
      continue;
    }

    if (skipping) {
      if (trimmed === "") {
        sawBlankWhileSkipping = true;
        pendingComments = [];
      } else if (sawBlankWhileSkipping && trimmed.startsWith("#")) {
        pendingComments.push(line);
      } else {
        sawBlankWhileSkipping = false;
        pendingComments = [];
      }
      continue;
    }

    kept.push(line);
  }

  if (pendingComments.length > 0) {
    if (kept.length > 0 && kept[kept.length - 1]?.trim() !== "") {
      kept.push("");
    }
    kept.push(...pendingComments);
  }

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function stripMcpTomlTables(source: string): string {
  return stripTomlTablesWhere(source, (segments) => segments[0] === "mcp_servers");
}

export function mergeMcpToml(
  existing: string,
  servers: MCPServerDefinition[],
  managedIds: string[],
  options: EncodeMcpTomlOptions = {},
): string {
  const managed = new Set([...managedIds, ...servers.map((s) => s.id)]);
  const rest = stripTomlTablesWhere(
    existing,
    (segments) =>
      segments[0] === "mcp_servers" &&
      segments.length >= 2 &&
      segments[1] !== undefined &&
      managed.has(segments[1]),
  );
  const encoded = encodeMcpToml(servers, options);
  if (rest.trim() === "") return encoded;
  if (encoded === "") return `${rest}\n`;
  return `${rest}\n\n${encoded}`;
}
