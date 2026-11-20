import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, MCPServerDefinition, MCPTransport } from "../types/index.js";

type OpenCodeEntry = {
  type?: string;
  command?: string[];
  url?: string;
  enabled?: boolean;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  oauth?: Record<string, unknown>;
};

type OpenCodeConfig = {
  mcp?: Record<string, OpenCodeEntry>;
  [key: string]: unknown;
};

const CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"] as const;

class OpenCodeMCPAdapter extends BaseMCPAdapter {
  readonly id = "opencode";
  readonly name = "OpenCode";
  readonly nativeSupport = true;
  readonly configPath = "opencode.json";
  declare readonly userConfigPath: string;
  readonly command = "opencode";

  constructor() {
    super();
    Object.defineProperty(this, "userConfigPath", {
      get: () => resolveOpenCodeUserConfigPath(),
      enumerable: true,
      configurable: true,
    });
  }

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (this.resolveProjectConfigPath(dir) !== null || existsSync(resolve(dir, ".opencode"))) {
      return true;
    }
    return this.commandExists(this.command);
  }

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    return [
      {
        path: this.configPath,
        content: `${JSON.stringify({ mcp: toOpenCodeMcp(servers) }, null, 2)}\n`,
        format: "json",
      },
    ];
  }

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const dir = cwd ?? process.cwd();
    const configPath = this.resolveProjectConfigPath(dir);
    if (!configPath) return [];
    return this.readOpenCode(configPath);
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    const explicitConfig = process.env.OPENCODE_CONFIG?.trim();
    if (explicitConfig) {
      return this.readOpenCode(resolve(explicitConfig));
    }
    const configDir = dirname(this.userConfigPath);
    for (const filename of CONFIG_FILENAMES) {
      const candidate = join(configDir, filename);
      if (existsSync(candidate)) {
        return this.readOpenCode(candidate);
      }
    }
    return [];
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = isAbsolute(file.path) ? file.path : resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      if (existsSync(fullPath)) {
        const existing = parseJsonc<OpenCodeConfig>(await readFile(fullPath, "utf-8"));
        const generated = JSON.parse(file.content) as { mcp?: Record<string, OpenCodeEntry> };
        existing.mcp = { ...existing.mcp, ...generated.mcp };
        await writeFile(fullPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
        continue;
      }
      await writeFile(fullPath, file.content, "utf-8");
    }
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = this.resolveProjectConfigPath(dir);
    if (!fullPath) return;

    const existing = parseJsonc<OpenCodeConfig>(await readFile(fullPath, "utf-8"));
    if (!("mcp" in existing)) return;

    delete existing.mcp;
    if (Object.keys(existing).length === 0) {
      await rm(fullPath);
    } else {
      await writeFile(fullPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
    }
  }

  private resolveProjectConfigPath(dir: string): string | null {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = resolve(dir, filename);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private async readOpenCode(fullPath: string): Promise<MCPServerDefinition[]> {
    if (!existsSync(fullPath)) return [];
    const data = parseJsonc<OpenCodeConfig>(await readFile(fullPath, "utf-8"));
    return fromOpenCodeMcp(data.mcp ?? {});
  }
}

function resolveOpenCodeUserConfigPath(): string {
  const explicitConfig = process.env.OPENCODE_CONFIG?.trim();
  if (explicitConfig) {
    return resolve(explicitConfig);
  }
  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return join(xdgConfigHome, "opencode", "opencode.json");
  }
  return join(homedir(), ".config", "opencode", "opencode.json");
}

/**
 * Strip single-line comments (`//`), block comments (`/* ... *\/`), and trailing
 * commas from JSONC text while preserving string literals.
 */
function stripJsonc(raw: string): string {
  let out = "";
  let inString = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inString) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < raw.length && raw[i] !== "\n" && raw[i] !== "\r") {
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
        i++;
      }
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  // Strip trailing commas before closing } or ] outside strings
  let cleaned = "";
  inString = false;
  for (let j = 0; j < out.length; j++) {
    const ch = out[j];
    const next = out[j + 1];

    if (inString) {
      cleaned += ch;
      if (ch === "\\" && next !== undefined) {
        cleaned += next;
        j++;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }

    if (ch === ",") {
      let k = j + 1;
      while (k < out.length && /\s/.test(out.charAt(k))) {
        k++;
      }
      if (out[k] === "}" || out[k] === "]") {
        continue;
      }
    }

    cleaned += ch;
  }

  return cleaned;
}

function parseJsonc<T>(raw: string): T {
  return JSON.parse(stripJsonc(raw)) as T;
}

function toOpenCodeMcp(servers: MCPServerDefinition[]): Record<string, OpenCodeEntry> {
  const mcp: Record<string, OpenCodeEntry> = {};
  for (const server of servers) {
    if (server.transport.type === "stdio") {
      const entry: OpenCodeEntry = {
        type: "local",
        command: [server.transport.command, ...(server.transport.args ?? [])],
        enabled: server.enabled !== false,
      };
      if (server.transport.env && Object.keys(server.transport.env).length > 0) {
        entry.environment = server.transport.env;
      }
      mcp[server.id] = entry;
    } else {
      const entry: OpenCodeEntry = {
        type: "remote",
        url: server.transport.url,
        enabled: server.enabled !== false,
      };
      if (server.transport.headers && Object.keys(server.transport.headers).length > 0) {
        entry.headers = server.transport.headers;
      }
      mcp[server.id] = entry;
    }
  }
  return mcp;
}

function fromOpenCodeMcp(mcp: Record<string, OpenCodeEntry>): MCPServerDefinition[] {
  const servers: MCPServerDefinition[] = [];
  for (const [id, entry] of Object.entries(mcp)) {
    if ((entry.type === "local" || entry.command) && entry.command && entry.command.length > 0) {
      const [command, ...args] = entry.command;
      if (command === undefined) continue;
      servers.push({
        id,
        name: id,
        transport: {
          type: "stdio",
          command,
          args,
          env: entry.environment,
        },
        enabled: entry.enabled,
      });
    } else if (entry.url) {
      const transport: Extract<MCPTransport, { url: string }> = { type: "http", url: entry.url };
      if (entry.headers) transport.headers = entry.headers;
      servers.push({
        id,
        name: id,
        transport,
        enabled: entry.enabled,
      });
    }
  }
  return servers;
}

const adapter = new OpenCodeMCPAdapter();
registry.register(adapter);

export { OpenCodeMCPAdapter, stripJsonc };
export default adapter;
