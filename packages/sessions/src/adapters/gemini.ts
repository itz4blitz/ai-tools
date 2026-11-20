import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { safeJsonParse } from "../utils/parser-helpers.js";
import type { UnifiedSession, SessionMessage, SessionFilter } from "../types/index.js";

type GeminiContentPart = {
  text?: string;
};

type GeminiMessage = {
  type?: string;
  role?: string;
  author?: string;
  content?: string | GeminiContentPart[];
  parts?: GeminiContentPart[];
  timestamp?: string;
};

type GeminiSessionJson = {
  id?: string;
  sessionId?: string;
  projectHash?: string;
  title?: string;
  messages?: GeminiMessage[];
  history?: GeminiMessage[];
  startTime?: string;
  lastUpdated?: string;
  createTime?: string;
  updateTime?: string;
};

type GeminiJsonlRecord = GeminiMessage & {
  sessionId?: string;
  projectHash?: string;
  title?: string;
  startTime?: string;
  lastUpdated?: string;
};

class GeminiSessionAdapter extends BaseSessionAdapter {
  readonly id = "gemini";
  readonly name = "Gemini CLI";
  readonly command = "gemini";
  readonly storagePaths = ["~/.gemini"];

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const storagePath = await this.getStoragePath();
    if (!storagePath) return [];

    const { readdir, readFile, stat } = await import("node:fs/promises");
    const { basename, resolve } = await import("node:path");

    const candidateFiles = await this.discoverSessionFiles(storagePath, readdir, resolve);
    const sessions: UnifiedSession[] = [];

    for (const filePath of candidateFiles) {
      try {
        const content = await readFile(filePath, "utf-8");
        const fileStat = await stat(filePath);
        const fileName = basename(filePath);
        const session = fileName.endsWith(".jsonl")
          ? this.parseJsonlSession(content, fileName, fileStat)
          : this.parseJsonSession(content, fileName, fileStat);

        if (session) {
          sessions.push(session);
        }
      } catch {
        // Skip malformed or unreadable files
      }
    }

    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    if (filter) {
      const { filterSessions } = await import("../utils/index.js");
      return filterSessions(sessions, filter);
    }

    return sessions;
  }

  private async discoverSessionFiles(
    storagePath: string,
    readdir: typeof import("node:fs/promises").readdir,
    resolve: typeof import("node:path").resolve,
  ): Promise<string[]> {
    const files: string[] = [];

    // 1. Primary Gemini CLI layout: ~/.gemini/tmp/<projectHash>/chats/session-*.{json,jsonl}
    const tmpDir = resolve(storagePath, "tmp");
    try {
      const projectEntries = await readdir(tmpDir, { withFileTypes: true });
      for (const entry of projectEntries) {
        if (!entry.isDirectory()) continue;
        const chatsDir = resolve(tmpDir, entry.name, "chats");
        try {
          const chatFiles = await readdir(chatsDir);
          for (const chatFile of chatFiles) {
            if (
              chatFile.startsWith("session-") &&
              (chatFile.endsWith(".json") || chatFile.endsWith(".jsonl"))
            ) {
              files.push(resolve(chatsDir, chatFile));
            }
          }
        } catch {
          // Project temp dir without chats/
        }
      }
    } catch {
      // No ~/.gemini/tmp directory
    }

    // 2. Fallback: legacy flat JSON files directly under ~/.gemini/*.json
    try {
      const rootFiles = await readdir(storagePath);
      for (const file of rootFiles) {
        if (file.endsWith(".json")) {
          files.push(resolve(storagePath, file));
        }
      }
    } catch {
      // Ignore unreadable root
    }

    return files;
  }

  private parseJsonSession(
    content: string,
    fileName: string,
    fileStat: { birthtime: Date; mtime: Date },
  ): UnifiedSession | null {
    const data = safeJsonParse<GeminiSessionJson>(content, {});
    const entries = data.messages ?? data.history ?? [];
    const messages: SessionMessage[] = [];

    for (const entry of entries) {
      const role = this.mapRole(entry);
      if (!role) continue;
      const text = this.extractText(entry);
      if (text) {
        messages.push({
          role,
          content: text,
          timestamp: entry.timestamp,
        });
      }
    }

    if (messages.length === 0) return null;

    const sessionId = data.sessionId ?? data.id ?? `gemini-${fileName.replace(/\.json$/, "")}`;
    const title = this.resolveSessionTitle(data.title, messages);

    return {
      id: sessionId,
      tool: this.id,
      toolName: this.name,
      title,
      startedAt: data.startTime ?? data.createTime ?? fileStat.birthtime.toISOString(),
      updatedAt: data.lastUpdated ?? data.updateTime ?? fileStat.mtime.toISOString(),
      messageCount: messages.length,
      messages,
      ...(data.projectHash ? { metadata: { projectHash: data.projectHash } } : {}),
    };
  }

  private parseJsonlSession(
    content: string,
    fileName: string,
    fileStat: { birthtime: Date; mtime: Date },
  ): UnifiedSession | null {
    const lines = content.split(/\r?\n/);
    let sessionId: string | undefined;
    let projectHash: string | undefined;
    let title: string | undefined;
    let startTime: string | undefined;
    let lastUpdated: string | undefined;
    const messages: SessionMessage[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const record = safeJsonParse<GeminiJsonlRecord | null>(line, null);
      if (!record || typeof record !== "object") continue;

      if (record.type === "session_metadata") {
        if (record.sessionId) sessionId = record.sessionId;
        if (record.projectHash) projectHash = record.projectHash;
        if (record.title) title = record.title;
        if (record.startTime) startTime = record.startTime;
        if (record.lastUpdated) lastUpdated = record.lastUpdated;
        continue;
      }

      if (record.lastUpdated) lastUpdated = record.lastUpdated;
      if (record.timestamp) lastUpdated = record.timestamp;

      const role = this.mapRole(record);
      if (!role) continue;
      const text = this.extractText(record);
      if (text) {
        messages.push({
          role,
          content: text,
          timestamp: record.timestamp,
        });
      }
    }

    if (messages.length === 0) return null;

    const resolvedId = sessionId ?? `gemini-${fileName.replace(/\.jsonl$/, "")}`;
    const resolvedTitle = this.resolveSessionTitle(title, messages);

    return {
      id: resolvedId,
      tool: this.id,
      toolName: this.name,
      title: resolvedTitle,
      startedAt: startTime ?? fileStat.birthtime.toISOString(),
      updatedAt: lastUpdated ?? fileStat.mtime.toISOString(),
      messageCount: messages.length,
      messages,
      ...(projectHash ? { metadata: { projectHash } } : {}),
    };
  }

  private mapRole(entry: GeminiMessage): SessionMessage["role"] | null {
    const role = entry.type ?? entry.role ?? entry.author;
    switch (role) {
      case "user":
      case "human":
        return "user";
      case "gemini":
      case "model":
      case "assistant":
        return "assistant";
      case "system":
      case "info":
        return "system";
      case "tool":
        return "tool";
      default:
        return null;
    }
  }

  private extractText(entry: GeminiMessage): string | null {
    if (typeof entry.content === "string" && entry.content.length > 0) {
      return entry.content;
    }

    if (Array.isArray(entry.content) && entry.content.length > 0) {
      const textParts = entry.content.filter((p) => p.text).map((p) => p.text ?? "");
      if (textParts.length > 0) return textParts.join("\n");
    }

    if (entry.parts && entry.parts.length > 0) {
      const textParts = entry.parts.filter((p) => p.text).map((p) => p.text ?? "");
      return textParts.length > 0 ? textParts.join("\n") : null;
    }

    return null;
  }
}

const adapter = new GeminiSessionAdapter();
registry.register(adapter);
export { GeminiSessionAdapter };
export default adapter;
