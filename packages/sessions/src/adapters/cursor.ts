import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { parseJsonl, safeJsonParse } from "../utils/parser-helpers.js";
import type { UnifiedSession, SessionMessage, SessionFilter } from "../types/index.js";

type CursorContentBlock = {
  type?: string;
  text?: string;
};

type CursorMessage = {
  role?: string;
  type?: string | number;
  content?: string | CursorContentBlock[];
  text?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | CursorContentBlock[];
    text?: string;
  };
};

type CursorSession = {
  id?: string;
  composerId?: string;
  title?: string;
  name?: string;
  createdAt?: number | string;
  lastUpdatedAt?: number | string;
  messages?: CursorMessage[];
  conversation?: CursorMessage[];
};

function extractText(content: string | CursorContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

function toValidIso(value: number | string | undefined, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function getCursorGlobalStateDbPath(): string {
  const home = homedir();
  switch (process.platform) {
    case "win32": {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
    }
    case "darwin":
      return join(
        home,
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      );
    default: {
      const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
      return join(xdgConfig, "Cursor", "User", "globalStorage", "state.vscdb");
    }
  }
}

class CursorSessionAdapter extends BaseSessionAdapter {
  readonly id = "cursor";
  readonly name = "Cursor";
  readonly command = "cursor";
  readonly storagePaths = ["~/.cursor"];

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const sessionsById = new Map<string, UnifiedSession>();
    const storagePath = await this.getStoragePath();

    if (storagePath) {
      // 1. Scan ~/.cursor/projects/*/agent-transcripts/*.jsonl (and nested transcript dirs)
      const transcriptSessions = await this.scanAgentTranscripts(storagePath);
      for (const session of transcriptSessions) {
        sessionsById.set(session.id, session);
      }

      // 2. Also scan legacy flat ~/.cursor/*.json* files
      const flatSessions = await this.scanFlatDir(storagePath);
      for (const session of flatSessions) {
        if (!sessionsById.has(session.id)) {
          sessionsById.set(session.id, session);
        }
      }
    }

    // 3. Optionally read OS-specific Cursor/User/globalStorage/state.vscdb composer sessions
    const vscdbSessions = await this.parseVscdbSessions();
    for (const session of vscdbSessions) {
      if (!sessionsById.has(session.id)) {
        sessionsById.set(session.id, session);
      }
    }

    const sessions = [...sessionsById.values()];
    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    if (filter) {
      const { filterSessions } = await import("../utils/index.js");
      return filterSessions(sessions, filter);
    }

    return sessions;
  }

  private async scanAgentTranscripts(storagePath: string): Promise<UnifiedSession[]> {
    const projectsDir = resolve(storagePath, "projects");
    if (!existsSync(projectsDir)) return [];

    let projectEntries: string[];
    try {
      projectEntries = await readdir(projectsDir);
    } catch {
      return [];
    }

    const sessions: UnifiedSession[] = [];

    for (const projectSlug of projectEntries) {
      const transcriptsDir = resolve(projectsDir, projectSlug, "agent-transcripts");
      if (!existsSync(transcriptsDir)) continue;

      let entries: string[];
      try {
        entries = await readdir(transcriptsDir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const entryPath = resolve(transcriptsDir, entry);

        if (entry.endsWith(".jsonl")) {
          try {
            const session = await this.parseJsonlFile(entryPath, entry, projectSlug);
            if (session) sessions.push(session);
          } catch {
            // Skip malformed transcript
          }
          continue;
        }

        // Handle nested transcript directories: agent-transcripts/<id>/<id>.jsonl
        try {
          const entryStat = await stat(entryPath);
          if (!entryStat.isDirectory()) continue;
          const nestedFiles = await readdir(entryPath);
          for (const nestedFile of nestedFiles) {
            if (!nestedFile.endsWith(".jsonl")) continue;
            try {
              const session = await this.parseJsonlFile(
                resolve(entryPath, nestedFile),
                nestedFile,
                projectSlug,
              );
              if (session) sessions.push(session);
            } catch {
              // Skip malformed nested transcript
            }
          }
        } catch {
          // Skip inaccessible entry
        }
      }
    }

    return sessions;
  }

  private async scanFlatDir(storagePath: string): Promise<UnifiedSession[]> {
    let files: string[];
    try {
      files = await readdir(storagePath);
    } catch {
      return [];
    }

    const sessions: UnifiedSession[] = [];

    for (const file of files) {
      const filePath = resolve(storagePath, file);

      try {
        if (file.endsWith(".jsonl")) {
          const session = await this.parseJsonlFile(filePath, file);
          if (session) sessions.push(session);
        } else if (file.endsWith(".json")) {
          const session = await this.parseJsonFile(filePath, file);
          if (session) sessions.push(session);
        }
      } catch {
        // Skip malformed files
      }
    }

    return sessions;
  }

  private async parseVscdbSessions(): Promise<UnifiedSession[]> {
    const dbPath = getCursorGlobalStateDbPath();
    if (!existsSync(dbPath)) return [];

    let db: {
      prepare: (sql: string) => { all: () => Array<{ key?: string; value?: string }> };
      close: () => void;
    } | null = null;

    try {
      // Optional built-in node:sqlite (Node 22.5+); fall back gracefully if unavailable
      const sqliteModule = (await import("node:sqlite")) as {
        DatabaseSync?: new (
          path: string,
          options?: { readOnly?: boolean },
        ) => {
          prepare: (sql: string) => { all: () => Array<{ key?: string; value?: string }> };
          close: () => void;
        };
      };
      if (!sqliteModule.DatabaseSync) return [];

      db = new sqliteModule.DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'")
        .all();

      const sessions: UnifiedSession[] = [];
      for (const row of rows) {
        try {
          if (typeof row.value !== "string") continue;
          const data = safeJsonParse<CursorSession>(row.value, {});
          const rawMessages = data.conversation ?? data.messages ?? [];
          const messages = this.extractMessages(rawMessages);
          if (messages.length === 0) continue;

          const fallbackId =
            typeof row.key === "string" ? row.key.replace(/^composerData:/, "") : "composer";
          const sessionId = `cursor-${data.composerId ?? data.id ?? fallbackId}`;
          const nowIso = new Date().toISOString();
          const startedAt = toValidIso(data.createdAt, nowIso);
          const updatedAt = toValidIso(data.lastUpdatedAt, startedAt);
          const title = this.resolveSessionTitle(data.name ?? data.title, messages);

          sessions.push({
            id: sessionId,
            tool: this.id,
            toolName: this.name,
            title,
            startedAt,
            updatedAt,
            messageCount: messages.length,
            messages,
          });
        } catch {
          // Skip malformed row without aborting remaining sessions
        }
      }

      return sessions;
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  private async parseJsonlFile(
    filePath: string,
    fileName: string,
    projectSlug?: string,
  ): Promise<UnifiedSession | null> {
    const content = await readFile(filePath, "utf-8");
    const entries = parseJsonl<CursorMessage>(content);
    const messages = this.extractMessages(entries);

    if (messages.length === 0) return null;

    const fileStat = await stat(filePath);
    const stem = basename(fileName, ".jsonl");
    const sessionId = `cursor-${stem}`;
    const title = this.resolveSessionTitle(undefined, messages);
    const projectPath = entries.find((e) => typeof e.cwd === "string")?.cwd ?? projectSlug;

    return {
      id: sessionId,
      tool: this.id,
      toolName: this.name,
      title,
      ...(projectPath ? { projectPath } : {}),
      startedAt: fileStat.birthtime.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
      messageCount: messages.length,
      messages,
    };
  }

  private async parseJsonFile(filePath: string, fileName: string): Promise<UnifiedSession | null> {
    const content = await readFile(filePath, "utf-8");
    const data = safeJsonParse<CursorSession>(content, {});

    const entries = data.messages ?? data.conversation ?? [];
    const messages = this.extractMessages(entries);

    if (messages.length === 0) return null;

    const fileStat = await stat(filePath);
    const sessionId = data.id ?? `cursor-${basename(fileName, ".json")}`;
    const title = this.resolveSessionTitle(data.title ?? data.name, messages);

    return {
      id: sessionId,
      tool: this.id,
      toolName: this.name,
      title,
      startedAt: fileStat.birthtime.toISOString(),
      updatedAt: fileStat.mtime.toISOString(),
      messageCount: messages.length,
      messages,
    };
  }

  private extractMessages(entries: CursorMessage[]): SessionMessage[] {
    const messages: SessionMessage[] = [];
    for (const entry of entries) {
      const role = this.mapRole(entry);
      if (!role) continue;
      const text =
        extractText(entry.content) ||
        extractText(entry.message?.content) ||
        entry.text ||
        entry.message?.text ||
        "";
      if (text) {
        messages.push({
          role,
          content: text,
          timestamp: entry.timestamp,
        });
      }
    }
    return messages;
  }

  private mapRole(entry: CursorMessage): SessionMessage["role"] | null {
    const role = entry.role ?? entry.message?.role ?? entry.type;
    switch (role) {
      case "user":
      case "human":
      case 1:
        return "user";
      case "assistant":
      case "ai":
      case 2:
        return "assistant";
      case "system":
        return "system";
      case "tool":
        return "tool";
      default:
        return null;
    }
  }
}

const adapter = new CursorSessionAdapter();
registry.register(adapter);
export { CursorSessionAdapter };
export default adapter;
