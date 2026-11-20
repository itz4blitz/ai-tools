import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { safeJsonParse } from "../utils/parser-helpers.js";
import type { UnifiedSession, SessionMessage, SessionFilter } from "../types/index.js";

type LegacyOpenCodeMessage = {
  role?: string;
  content?: string;
  text?: string;
  timestamp?: string | number;
};

type LegacyOpenCodeSession = {
  id?: string;
  title?: string;
  messages?: LegacyOpenCodeMessage[];
  createdAt?: string | number;
  updatedAt?: string | number;
  path?: string;
  directory?: string;
};

type V1SessionRecord = {
  id?: string;
  title?: string;
  directory?: string;
  path?: string;
  time?: {
    created?: number | string;
    updated?: number | string;
  };
  createdAt?: number | string;
  updatedAt?: number | string;
};

type V1MessageRecord = {
  id?: string;
  sessionID?: string;
  role?: string;
  content?: string;
  text?: string;
  time?: {
    created?: number | string;
    completed?: number | string;
  };
  timestamp?: number | string;
};

type V1PartRecord = {
  id?: string;
  messageID?: string;
  sessionID?: string;
  type?: string;
  text?: string;
  content?: string;
  tool?: string;
  state?: {
    input?: unknown;
    output?: unknown;
  };
  time?: {
    start?: number | string;
    created?: number | string;
  };
};

type SqliteSessionRow = {
  id?: string;
  title?: string | null;
  directory?: string | null;
  time_created?: number | string | null;
  time_updated?: number | string | null;
};

type SqliteMessageRow = {
  id?: string;
  session_id?: string;
  time_created?: number | string | null;
  data?: string | null;
};

type SqlitePartRow = {
  id?: string;
  message_id?: string;
  session_id?: string;
  time_created?: number | string | null;
  data?: string | null;
};

class OpenCodeSessionAdapter extends BaseSessionAdapter {
  readonly id = "opencode";
  readonly name = "OpenCode";
  readonly command = "opencode";

  get storagePaths(): string[] {
    const candidates: string[] = [];
    const envData = process.env.OPENCODE_DATA?.trim();
    if (envData) {
      candidates.push(resolve(envData));
    }
    const xdgData = process.env.XDG_DATA_HOME?.trim();
    if (xdgData) {
      candidates.push(join(xdgData, "opencode"));
    }
    candidates.push(join(homedir(), ".local", "share", "opencode"));

    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (localAppData) {
      candidates.push(join(localAppData, "opencode"));
    }

    // Legacy fallback locations
    candidates.push(join(homedir(), ".opencode", "sessions"));
    candidates.push(join(homedir(), ".opencode"));

    return [...new Set(candidates)];
  }

  override async getStoragePath(): Promise<string | null> {
    for (const candidate of this.storagePaths) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  override async detect(): Promise<boolean> {
    if ((await this.getStoragePath()) !== null) {
      return true;
    }
    const { execFile } = await import("node:child_process");
    const lookupCommand = process.platform === "win32" ? "where" : "which";
    return new Promise((ok) => {
      execFile(lookupCommand, [this.command], (error) => {
        ok(!error);
      });
    });
  }

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const storagePath = await this.getStoragePath();
    if (!storagePath) return [];

    const sessionsById = new Map<string, UnifiedSession>();

    // 1. OpenCode v2 SQLite database (`opencode.db`)
    const dbPath = join(storagePath, "opencode.db");
    if (existsSync(dbPath)) {
      const sqliteSessions = await this.parseSqliteSessions(dbPath);
      for (const session of sqliteSessions) {
        sessionsById.set(session.id, session);
      }
    }

    // 2. OpenCode v1 `storage/` tree (`session/`, `message/`, `part/`)
    const v1StorageDir = join(storagePath, "storage");
    if (existsSync(join(v1StorageDir, "session"))) {
      const v1Sessions = await this.parseV1StorageSessions(v1StorageDir);
      for (const session of v1Sessions) {
        if (!sessionsById.has(session.id)) {
          sessionsById.set(session.id, session);
        }
      }
    }

    // 3. Legacy flat JSON files directly in storagePath
    if (sessionsById.size === 0) {
      const legacySessions = await this.parseLegacyJsonSessions(storagePath);
      for (const session of legacySessions) {
        if (!sessionsById.has(session.id)) {
          sessionsById.set(session.id, session);
        }
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

  private async parseSqliteSessions(dbPath: string): Promise<UnifiedSession[]> {
    type StatementLike = { all: (...params: unknown[]) => unknown[] };
    type DatabaseLike = {
      prepare: (sql: string) => StatementLike;
      close: () => void;
    };

    let DatabaseSyncCtor:
      | (new (path: string, options?: { readOnly?: boolean }) => DatabaseLike)
      | undefined;

    try {
      const sqliteMod = (await import("node:sqlite")) as unknown as {
        DatabaseSync?: new (path: string, options?: { readOnly?: boolean }) => DatabaseLike;
      };
      DatabaseSyncCtor = sqliteMod.DatabaseSync;
    } catch {
      return [];
    }

    if (!DatabaseSyncCtor) return [];

    let db: DatabaseLike | undefined;
    try {
      db = new DatabaseSyncCtor(dbPath, { readOnly: true });
      const sessionRows = db
        .prepare("SELECT id, title, directory, time_created, time_updated FROM session")
        .all() as SqliteSessionRow[];

      const messageRows = db
        .prepare(
          "SELECT id, session_id, time_created, data FROM message ORDER BY time_created ASC, id ASC",
        )
        .all() as SqliteMessageRow[];

      const partRows = db
        .prepare(
          "SELECT id, message_id, session_id, time_created, data FROM part ORDER BY time_created ASC, id ASC",
        )
        .all() as SqlitePartRow[];

      const partsByMessage = new Map<string, V1PartRecord[]>();
      for (const row of partRows) {
        if (!row.message_id || !row.data) continue;
        const parsed = safeJsonParse<V1PartRecord>(row.data, {});
        const list = partsByMessage.get(row.message_id) ?? [];
        list.push(parsed);
        partsByMessage.set(row.message_id, list);
      }

      const messagesBySession = new Map<string, SessionMessage[]>();
      for (const row of messageRows) {
        if (!row.session_id || !row.id) continue;
        const parsed = row.data ? safeJsonParse<V1MessageRecord>(row.data, {}) : {};
        const role = this.mapRole(parsed.role);
        if (!role) continue;

        const parts = partsByMessage.get(row.id) ?? [];
        const content = this.extractMessageText(parsed, parts);
        if (!content) continue;

        const timestamp = toOptionalIsoTimestamp(
          parsed.time?.created ?? parsed.timestamp ?? row.time_created,
        );

        const list = messagesBySession.get(row.session_id) ?? [];
        list.push({ role, content, timestamp });
        messagesBySession.set(row.session_id, list);
      }

      const nowIso = new Date().toISOString();
      const sessions: UnifiedSession[] = [];
      for (const row of sessionRows) {
        if (!row.id) continue;
        const messages = messagesBySession.get(row.id) ?? [];
        if (messages.length === 0) continue;

        const startedAt = toIsoTimestamp(row.time_created, nowIso);
        const updatedAt = toIsoTimestamp(row.time_updated, startedAt);
        const title = this.resolveSessionTitle(row.title ?? undefined, messages);

        sessions.push({
          id: row.id,
          tool: this.id,
          toolName: this.name,
          title,
          projectPath: row.directory ?? undefined,
          startedAt,
          updatedAt,
          messageCount: messages.length,
          messages,
        });
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

  private async parseV1StorageSessions(v1StorageDir: string): Promise<UnifiedSession[]> {
    const sessionRoot = join(v1StorageDir, "session");
    const messageRoot = join(v1StorageDir, "message");
    const partRoot = join(v1StorageDir, "part");

    const sessionFiles = await this.collectJsonFiles(sessionRoot);
    const sessions: UnifiedSession[] = [];

    for (const sessionFile of sessionFiles) {
      try {
        const raw = await readFile(sessionFile, "utf-8");
        const sessionData = safeJsonParse<V1SessionRecord>(raw, {});
        const sessionId = sessionData.id;
        if (!sessionId) continue;

        const msgDir = join(messageRoot, sessionId);
        if (!existsSync(msgDir)) continue;

        const msgFiles = await this.collectJsonFiles(msgDir);
        const parsedMessages: Array<{ sortKey: number; id: string; msg: V1MessageRecord }> = [];

        for (const msgFile of msgFiles) {
          try {
            const msgRaw = await readFile(msgFile, "utf-8");
            const msgData = safeJsonParse<V1MessageRecord>(msgRaw, {});
            const sortKey = toEpochMs(msgData.time?.created ?? msgData.timestamp);
            parsedMessages.push({ sortKey, id: msgData.id ?? msgFile, msg: msgData });
          } catch {
            // Skip malformed message file
          }
        }

        parsedMessages.sort((a, b) => a.sortKey - b.sortKey || a.id.localeCompare(b.id));

        const messages: SessionMessage[] = [];
        for (const { msg } of parsedMessages) {
          const role = this.mapRole(msg.role);
          if (!role) continue;

          const parts: V1PartRecord[] = [];
          if (msg.id) {
            const msgPartDir = join(partRoot, msg.id);
            if (existsSync(msgPartDir)) {
              const partFiles = await this.collectJsonFiles(msgPartDir);
              const parsedParts: Array<{ sortKey: number; id: string; part: V1PartRecord }> = [];
              for (const partFile of partFiles) {
                try {
                  const partRaw = await readFile(partFile, "utf-8");
                  const partData = safeJsonParse<V1PartRecord>(partRaw, {});
                  const sortKey = toEpochMs(partData.time?.created ?? partData.time?.start);
                  parsedParts.push({ sortKey, id: partData.id ?? partFile, part: partData });
                } catch {
                  // Skip malformed part file
                }
              }
              parsedParts.sort((a, b) => a.sortKey - b.sortKey || a.id.localeCompare(b.id));
              for (const item of parsedParts) {
                parts.push(item.part);
              }
            }
          }

          const content = this.extractMessageText(msg, parts);
          if (!content) continue;

          messages.push({
            role,
            content,
            timestamp: toOptionalIsoTimestamp(msg.time?.created ?? msg.timestamp),
          });
        }

        if (messages.length === 0) continue;

        const fileStat = await stat(sessionFile);
        const startedAt = toIsoTimestamp(
          sessionData.time?.created ?? sessionData.createdAt,
          fileStat.birthtime.toISOString(),
        );
        const updatedAt = toIsoTimestamp(
          sessionData.time?.updated ?? sessionData.updatedAt,
          fileStat.mtime.toISOString(),
        );
        const title = this.resolveSessionTitle(sessionData.title, messages);

        sessions.push({
          id: sessionId,
          tool: this.id,
          toolName: this.name,
          title,
          projectPath: sessionData.directory ?? sessionData.path,
          startedAt,
          updatedAt,
          messageCount: messages.length,
          messages,
        });
      } catch {
        // Skip malformed session file
      }
    }

    return sessions;
  }

  private async parseLegacyJsonSessions(storagePath: string): Promise<UnifiedSession[]> {
    const sessions: UnifiedSession[] = [];
    let files: string[];
    try {
      files = await readdir(storagePath);
    } catch {
      return [];
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const filePath = resolve(storagePath, file);

      try {
        const content = await readFile(filePath, "utf-8");
        const data = safeJsonParse<LegacyOpenCodeSession>(content, {});

        const entries = data.messages ?? [];
        const messages: SessionMessage[] = [];

        for (const entry of entries) {
          const role = this.mapRole(entry.role);
          if (!role) continue;
          const text = entry.content ?? entry.text;
          if (text) {
            messages.push({
              role,
              content: text,
              timestamp: toOptionalIsoTimestamp(entry.timestamp),
            });
          }
        }

        if (messages.length === 0) continue;

        const fileStat = await stat(filePath);
        const sessionId = data.id ?? `opencode-${file.replace(".json", "")}`;
        const title = this.resolveSessionTitle(data.title, messages);

        sessions.push({
          id: sessionId,
          tool: this.id,
          toolName: this.name,
          title,
          projectPath: data.directory ?? data.path,
          startedAt: toIsoTimestamp(data.createdAt, fileStat.birthtime.toISOString()),
          updatedAt: toIsoTimestamp(data.updatedAt, fileStat.mtime.toISOString()),
          messageCount: messages.length,
          messages,
        });
      } catch {
        // Skip malformed files
      }
    }

    return sessions;
  }

  private async collectJsonFiles(dir: string): Promise<string[]> {
    const result: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return result;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...(await this.collectJsonFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        result.push(fullPath);
      }
    }
    return result;
  }

  private extractMessageText(msg: V1MessageRecord, parts: V1PartRecord[]): string {
    const chunks: string[] = [];
    for (const part of parts) {
      if (part.type === "text" || part.type === undefined) {
        const text = part.text ?? part.content;
        if (text && text.trim()) {
          chunks.push(text.trim());
        }
      }
    }
    if (chunks.length > 0) {
      return chunks.join("\n\n");
    }
    return (msg.content ?? msg.text ?? "").trim();
  }

  private mapRole(role?: string): SessionMessage["role"] | null {
    switch (role) {
      case "user":
      case "human":
        return "user";
      case "assistant":
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

function toEpochMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && value.trim() !== "") {
      return asNum < 1e12 ? asNum * 1000 : asNum;
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function toOptionalIsoTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    return value;
  }
  return undefined;
}

function toIsoTimestamp(value: unknown, fallback: string): string {
  return toOptionalIsoTimestamp(value) ?? fallback;
}

const adapter = new OpenCodeSessionAdapter();
registry.register(adapter);
export { OpenCodeSessionAdapter };
export default adapter;
