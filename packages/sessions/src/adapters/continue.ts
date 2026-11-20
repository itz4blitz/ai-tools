import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { safeJsonParse } from "../utils/parser-helpers.js";
import type { SessionFilter, SessionMessage, UnifiedSession } from "../types/index.js";

type ContinueContentPart = {
  type?: string;
  text?: string;
};

type ContinueMessage = {
  role?: string;
  content?: string | ContinueContentPart[];
  timestamp?: string | number;
};

type ContinueHistoryItem = {
  message?: ContinueMessage;
  role?: string;
  content?: string | ContinueContentPart[];
  timestamp?: string | number;
};

type ContinueSessionFile = {
  sessionId?: string;
  id?: string;
  title?: string;
  workspaceDirectory?: string;
  dateCreated?: string | number;
  updatedAt?: string | number;
  history?: ContinueHistoryItem[];
  messages?: ContinueHistoryItem[];
};

class ContinueSessionAdapter extends BaseSessionAdapter {
  readonly id = "continue";
  readonly name = "Continue";
  readonly command = "cn";
  readonly storagePaths = ["~/.continue/sessions"];

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const storagePath = await this.getStoragePath();
    if (!storagePath) return [];

    const { readdir, readFile, stat } = await import("node:fs/promises");
    const { resolve } = await import("node:path");

    let files: string[];
    try {
      files = await readdir(storagePath);
    } catch {
      return [];
    }

    const sessions: UnifiedSession[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      if (file.toLowerCase() === "sessions.json") continue;

      const filePath = resolve(storagePath, file);
      try {
        const content = await readFile(filePath, "utf-8");
        const data = safeJsonParse<ContinueSessionFile>(content, {});

        const entries = Array.isArray(data.history)
          ? data.history
          : Array.isArray(data.messages)
            ? data.messages
            : [];

        const messages: SessionMessage[] = [];
        for (const item of entries) {
          if (!item || typeof item !== "object") continue;
          const msg = item.message ?? item;
          const role = this.mapRole(msg.role);
          if (!role) continue;
          const text = this.extractText(msg.content);
          if (!text) continue;
          const timestamp = this.toIsoTimestamp(msg.timestamp ?? item.timestamp);
          messages.push(timestamp ? { role, content: text, timestamp } : { role, content: text });
        }

        if (messages.length === 0) continue;

        const fileStat = await stat(filePath);
        const sessionId = data.sessionId ?? data.id ?? `continue-${file.replace(/\.json$/i, "")}`;
        const title = this.resolveSessionTitle(data.title, messages);
        const startedAt = this.toIsoTimestamp(data.dateCreated) ?? fileStat.birthtime.toISOString();
        const updatedAt = this.toIsoTimestamp(data.updatedAt) ?? fileStat.mtime.toISOString();

        sessions.push({
          id: sessionId,
          tool: this.id,
          toolName: this.name,
          title,
          projectPath: data.workspaceDirectory,
          startedAt,
          updatedAt,
          messageCount: messages.length,
          messages,
        });
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

  private mapRole(role: string | undefined): SessionMessage["role"] | null {
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
        return "tool";
      default:
        return null;
    }
  }

  private extractText(content: string | ContinueContentPart[] | undefined): string | null {
    if (typeof content === "string") {
      const trimmed = content.trim();
      return trimmed.length > 0 ? trimmed : null;
    }

    if (Array.isArray(content)) {
      const parts = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && typeof part.text === "string") {
            return part.text;
          }
          return "";
        })
        .filter((text) => text.trim().length > 0);
      return parts.length > 0 ? parts.join("\n") : null;
    }

    return null;
  }

  private toIsoTimestamp(value: string | number | undefined): string | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value).toISOString();
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && /^\d+$/.test(value.trim())) {
        return new Date(numeric).toISOString();
      }
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return new Date(parsed).toISOString();
      }
    }
    return undefined;
  }
}

const adapter = new ContinueSessionAdapter();
registry.register(adapter);
export { ContinueSessionAdapter };
export default adapter;
