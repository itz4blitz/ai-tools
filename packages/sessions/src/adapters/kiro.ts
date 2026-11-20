import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { parseJsonl, safeJsonParse } from "../utils/parser-helpers.js";
import type { SessionFilter, SessionMessage, UnifiedSession } from "../types/index.js";

type KiroSessionMeta = {
  session_id?: string;
  id?: string;
  title?: string;
  name?: string;
  cwd?: string;
  working_directory?: string;
  projectPath?: string;
  created_at?: string | number;
  startedAt?: string | number;
  updated_at?: string | number;
  updatedAt?: string | number;
  model?: string;
  agent?: string;
  messages?: KiroSessionEntry[];
};

type KiroContentPart = {
  type?: string;
  text?: string;
};

type KiroSessionEntry = {
  role?: string;
  type?: string;
  content?: string | KiroContentPart[];
  text?: string;
  timestamp?: string | number;
  toolName?: string;
  tool_name?: string;
  message?: {
    role?: string;
    content?: string | KiroContentPart[];
  };
};

class KiroSessionAdapter extends BaseSessionAdapter {
  readonly id = "kiro";
  readonly name = "Kiro CLI";
  readonly command = "kiro-cli";
  readonly storagePaths = ["~/.kiro/sessions/cli"];

  override async detect(): Promise<boolean> {
    if ((await this.commandExists("kiro-cli")) || (await this.commandExists("kiro"))) {
      return true;
    }
    return (await this.getStoragePath()) !== null;
  }

  override async getStoragePath(): Promise<string | null> {
    const kiroHome = process.env.KIRO_HOME?.trim();
    const candidates = kiroHome
      ? [join(kiroHome, "sessions", "cli"), join(homedir(), ".kiro", "sessions", "cli")]
      : [join(homedir(), ".kiro", "sessions", "cli")];

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const storagePath = await this.getStoragePath();
    if (!storagePath) return [];

    let files: string[];
    try {
      files = await readdir(storagePath);
    } catch {
      return [];
    }

    const pairs = new Map<string, { jsonPath?: string; jsonlPath?: string }>();
    for (const file of files) {
      if (file.endsWith(".jsonl")) {
        const baseId = file.slice(0, -".jsonl".length);
        const existing = pairs.get(baseId) ?? {};
        existing.jsonlPath = resolve(storagePath, file);
        pairs.set(baseId, existing);
      } else if (file.endsWith(".json")) {
        const baseId = file.slice(0, -".json".length);
        const existing = pairs.get(baseId) ?? {};
        existing.jsonPath = resolve(storagePath, file);
        pairs.set(baseId, existing);
      }
    }

    const sessions: UnifiedSession[] = [];

    for (const [baseId, pair] of pairs) {
      try {
        const session = await this.parseSessionPair(baseId, pair);
        if (session) sessions.push(session);
      } catch {
        // Skip malformed session files
      }
    }

    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    if (filter) {
      const { filterSessions } = await import("../utils/index.js");
      return filterSessions(sessions, filter);
    }

    return sessions;
  }

  protected override async commandExists(command: string): Promise<boolean> {
    const { execFile } = await import("node:child_process");
    const lookupCommand = process.platform === "win32" ? "where" : "which";
    return new Promise((ok) => {
      execFile(lookupCommand, [command], (error) => {
        ok(!error);
      });
    });
  }

  private async parseSessionPair(
    baseId: string,
    pair: { jsonPath?: string; jsonlPath?: string },
  ): Promise<UnifiedSession | null> {
    let meta: KiroSessionMeta = {};
    if (pair.jsonPath) {
      const rawMeta = await readFile(pair.jsonPath, "utf-8");
      meta = safeJsonParse<KiroSessionMeta>(rawMeta, {});
    }

    let entries: KiroSessionEntry[] = [];
    if (pair.jsonlPath) {
      const rawLog = await readFile(pair.jsonlPath, "utf-8");
      entries = parseJsonl<KiroSessionEntry>(rawLog);
    } else if (Array.isArray(meta.messages)) {
      entries = meta.messages;
    }

    const messages: SessionMessage[] = [];
    for (const entry of entries) {
      const role = this.mapRole(entry);
      if (!role) continue;
      const content = this.extractContent(entry);
      if (!content) continue;

      const msg: SessionMessage = { role, content };
      const timestamp = normalizeTimestamp(entry.timestamp);
      if (timestamp) msg.timestamp = timestamp;
      const toolName = entry.toolName ?? entry.tool_name;
      if (toolName) msg.toolName = toolName;
      messages.push(msg);
    }

    if (messages.length === 0) return null;

    const statTarget = pair.jsonlPath ?? pair.jsonPath;
    if (!statTarget) return null;
    const fileStat = await stat(statTarget);

    const sessionId = meta.session_id ?? meta.id ?? `kiro-${baseId}`;
    const title = this.resolveSessionTitle(meta.title ?? meta.name, messages);
    const projectPath = meta.cwd ?? meta.working_directory ?? meta.projectPath;
    const startedAt =
      normalizeTimestamp(meta.created_at ?? meta.startedAt) ?? fileStat.birthtime.toISOString();
    const updatedAt =
      normalizeTimestamp(meta.updated_at ?? meta.updatedAt) ?? fileStat.mtime.toISOString();

    const metadata: Record<string, unknown> = {};
    if (meta.model) metadata.model = meta.model;
    if (meta.agent) metadata.agent = meta.agent;

    return {
      id: sessionId,
      tool: this.id,
      toolName: this.name,
      title,
      projectPath,
      startedAt,
      updatedAt,
      messageCount: messages.length,
      messages,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }

  private mapRole(entry: KiroSessionEntry): SessionMessage["role"] | null {
    const role = entry.role ?? entry.message?.role ?? entry.type;
    switch (role) {
      case "user":
      case "human":
        return "user";
      case "assistant":
      case "model":
        return "assistant";
      case "system":
        return "system";
      case "tool":
      case "tool_result":
        return "tool";
      default:
        return null;
    }
  }

  private extractContent(entry: KiroSessionEntry): string | null {
    const raw = entry.content ?? entry.message?.content ?? entry.text;
    if (typeof raw === "string") {
      return raw.trim() ? raw : null;
    }
    if (Array.isArray(raw)) {
      const parts = raw
        .filter((part) => typeof part?.text === "string" && part.text.length > 0)
        .map((part) => part.text ?? "");
      return parts.length > 0 ? parts.join("\n") : null;
    }
    return null;
  }
}

function normalizeTimestamp(value: string | number | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return undefined;
}

const adapter = new KiroSessionAdapter();
registry.register(adapter);

export { KiroSessionAdapter };
export default adapter;
