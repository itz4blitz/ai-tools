import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BaseMCPAdapter } from "./base.js";
import { registry } from "./registry.js";
import type { GeneratedFile, MCPServerDefinition, MCPTransport } from "../types/index.js";

type ZcodeServer = {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

class ZcodeMCPAdapter extends BaseMCPAdapter {
  readonly id = "zcode";
  readonly name = "ZCode";
  readonly nativeSupport = true;
  readonly configPath = ".zcode/config.json";
  readonly userConfigPath = join(homedir(), ".zcode", "cli", "config.json");
  readonly command = "zcode";

  override async detect(cwd?: string): Promise<boolean> {
    if (await super.detect(cwd)) return true;
    const dir = cwd ?? process.cwd();
    return (
      existsSync(resolve(dir, ".zcode")) ||
      existsSync(this.userConfigPath) ||
      existsSync(join(homedir(), ".zcode"))
    );
  }

  async generate(servers: MCPServerDefinition[]): Promise<GeneratedFile[]> {
    return [
      {
        path: this.configPath,
        content: `${JSON.stringify({ mcp: { servers: toZcodeServers(servers) } }, null, 2)}\n`,
        format: "json",
      },
    ];
  }

  async import(cwd?: string): Promise<MCPServerDefinition[]> {
    const dir = cwd ?? process.cwd();
    return this.readZcode(resolve(dir, this.configPath));
  }

  override async importUser(): Promise<MCPServerDefinition[]> {
    return this.readZcode(this.userConfigPath);
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = isAbsolute(file.path) ? file.path : resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      if (existsSync(fullPath)) {
        const existing = (await readJsonRecord(fullPath)) ?? {};
        const generated = parseJsonRecord(file.content) ?? {};
        const existingMcp = asRecord(existing.mcp);
        const generatedMcp = asRecord(generated.mcp);
        existing.mcp = {
          ...existingMcp,
          servers: {
            ...asRecord(existingMcp.servers),
            ...asRecord(generatedMcp.servers),
          },
        };
        await writeFile(fullPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
        continue;
      }
      await writeFile(fullPath, file.content, "utf-8");
    }
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const fullPath = resolve(dir, this.configPath);
    if (!existsSync(fullPath)) return;

    const existing = await readJsonRecord(fullPath);
    if (!existing) return;

    const existingMcp = asRecord(existing.mcp);
    if (Object.keys(existingMcp).length > 0 && "servers" in existingMcp) {
      const nextMcp = { ...existingMcp };
      delete nextMcp.servers;
      if (Object.keys(nextMcp).length > 0) {
        existing.mcp = nextMcp;
      } else {
        delete existing.mcp;
      }
    }

    if (Object.keys(existing).length === 0) {
      await rm(fullPath);
      return;
    }

    await writeFile(fullPath, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
  }

  private async readZcode(fullPath: string): Promise<MCPServerDefinition[]> {
    const data = await readJsonRecord(fullPath);
    if (!data) return [];
    const mcp = asRecord(data.mcp);
    const servers = asRecord(mcp.servers);
    return fromZcodeServers(servers);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

async function readJsonRecord(fullPath: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(fullPath)) return null;
  try {
    return parseJsonRecord(await readFile(fullPath, "utf-8"));
  } catch {
    return null;
  }
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toZcodeServers(servers: MCPServerDefinition[]): Record<string, ZcodeServer> {
  const out: Record<string, ZcodeServer> = {};
  for (const server of servers) {
    out[server.id] = toZcodeServer(server);
  }
  return out;
}

function toZcodeServer(server: MCPServerDefinition): ZcodeServer {
  if (server.transport.type === "stdio") {
    const spec: ZcodeServer = {
      type: "stdio",
      command: server.transport.command,
      args: server.transport.args ?? [],
    };
    if (server.transport.env && Object.keys(server.transport.env).length > 0) {
      spec.env = server.transport.env;
    }
    return spec;
  }
  const spec: ZcodeServer = {
    type: server.transport.type,
    url: server.transport.url,
  };
  if (server.transport.headers && Object.keys(server.transport.headers).length > 0) {
    spec.headers = server.transport.headers;
  }
  return spec;
}

function fromZcodeServers(servers: Record<string, unknown>): MCPServerDefinition[] {
  const out: MCPServerDefinition[] = [];
  for (const [id, rawSpec] of Object.entries(servers)) {
    if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) continue;
    const spec = rawSpec as ZcodeServer;
    if (typeof spec.command === "string") {
      const transport: Extract<MCPTransport, { type: "stdio" }> = {
        type: "stdio",
        command: spec.command,
      };
      if (Array.isArray(spec.args)) {
        transport.args = spec.args.filter((arg): arg is string => typeof arg === "string");
      }
      const env = asStringRecord(spec.env);
      if (env) transport.env = env;
      out.push({ id, name: id, transport });
    } else if (typeof spec.url === "string") {
      const type = spec.type === "sse" ? "sse" : "http";
      const transport: Extract<MCPTransport, { url: string }> = { type, url: spec.url };
      const headers = asStringRecord(spec.headers);
      if (headers) transport.headers = headers;
      out.push({ id, name: id, transport });
    }
  }
  return out;
}

const adapter = new ZcodeMCPAdapter();
registry.register(adapter);

export { ZcodeMCPAdapter };
export default adapter;
