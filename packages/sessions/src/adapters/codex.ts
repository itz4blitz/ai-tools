import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { parseJsonl } from "../utils/parser-helpers.js";
import { filterSessions } from "../utils/index.js";
import type { UnifiedSession, SessionMessage, SessionFilter } from "../types/index.js";

type CodexContentBlock = {
  type?: string;
  text?: string;
};

type CodexSessionMetaPayload = {
  id?: string;
  timestamp?: string;
  cwd?: string;
};

type CodexResponseItemPayload = {
  type?: string;
  role?: string;
  content?: string | CodexContentBlock[];
};

type CodexRolloutEntry = {
  timestamp?: string;
  type?: string;
  payload?: CodexSessionMetaPayload & CodexResponseItemPayload;
};

class CodexSessionAdapter extends BaseSessionAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  readonly command = "codex";
  readonly storagePaths = ["~/.codex/sessions"];

  override async getStoragePath(): Promise<string | null> {
    const codexHome = process.env.CODEX_HOME?.trim();
    const sessionsDir = codexHome
      ? join(codexHome, "sessions")
      : join(homedir(), ".codex", "sessions");
    return existsSync(sessionsDir) ? sessionsDir : null;
  }

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const storagePath = await this.getStoragePath();
    if (!storagePath) return [];

    const files = await this.collectRolloutFiles(storagePath);
    const sessions: UnifiedSession[] = [];

    for (const filePath of files) {
      try {
        const content = await readFile(filePath, "utf-8");
        const entries = parseJsonl<CodexRolloutEntry>(content);

        let metaId: string | undefined;
        let projectPath: string | undefined;
        let metaTimestamp: string | undefined;
        let latestTimestamp: string | undefined;
        const messages: SessionMessage[] = [];

        for (const entry of entries) {
          if (entry.type === "session_meta" && entry.payload) {
            if (typeof entry.payload.id === "string" && entry.payload.id.trim().length > 0) {
              metaId = entry.payload.id.trim();
            }
            if (typeof entry.payload.cwd === "string" && entry.payload.cwd.trim().length > 0) {
              projectPath = entry.payload.cwd.trim();
            }
            const candidateTs = entry.payload.timestamp ?? entry.timestamp;
            if (this.isValidTimestamp(candidateTs)) {
              metaTimestamp = candidateTs;
              latestTimestamp = this.maxTimestamp(latestTimestamp, candidateTs);
            }
            continue;
          }

          // Ignore event_msg entries to avoid double-counting user/agent messages.
          if (entry.type !== "response_item" || entry.payload?.type !== "message") {
            continue;
          }

          const role = this.mapRole(entry.payload.role);
          if (!role) continue;

          const text = this.extractText(entry.payload.content);
          if (!text) continue;

          const msgTimestamp = this.isValidTimestamp(entry.timestamp) ? entry.timestamp : undefined;
          if (msgTimestamp) {
            latestTimestamp = this.maxTimestamp(latestTimestamp, msgTimestamp);
          }

          messages.push(
            msgTimestamp
              ? { role, content: text, timestamp: msgTimestamp }
              : { role, content: text },
          );
        }

        if (messages.length === 0) continue;

        const fileStat = await stat(filePath);
        const fallbackId = basename(filePath, ".jsonl");
        const sessionId = metaId
          ? metaId.startsWith("codex-")
            ? metaId
            : `codex-${metaId}`
          : `codex-${fallbackId}`;
        const startedAt = metaTimestamp ?? fileStat.birthtime.toISOString();
        const updatedAt = latestTimestamp ?? fileStat.mtime.toISOString();
        const title = this.resolveSessionTitle(undefined, messages);

        sessions.push({
          id: sessionId,
          tool: this.id,
          toolName: this.name,
          title,
          ...(projectPath ? { projectPath } : {}),
          startedAt,
          updatedAt,
          messageCount: messages.length,
          messages,
        });
      } catch {
        // Skip malformed or unreadable rollout files
      }
    }

    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    if (filter) {
      return filterSessions(sessions, filter);
    }

    return sessions;
  }

  private async collectRolloutFiles(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.collectRolloutFiles(fullPath)));
      } else if (
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(".jsonl")
      ) {
        files.push(fullPath);
      }
    }
    return files;
  }

  private extractText(content: string | CodexContentBlock[] | undefined): string {
    if (typeof content === "string") {
      return content.trim();
    }
    if (!Array.isArray(content)) {
      return "";
    }
    const parts: string[] = [];
    for (const block of content) {
      if (
        (block.type === "input_text" || block.type === "output_text") &&
        typeof block.text === "string" &&
        block.text.length > 0
      ) {
        parts.push(block.text);
      }
    }
    return parts.join("\n").trim();
  }

  private mapRole(role: string | undefined): SessionMessage["role"] | null {
    switch (role) {
      case "user":
      case "human":
        return "user";
      case "assistant":
        return "assistant";
      case "system":
      case "developer":
        return "system";
      case "tool":
        return "tool";
      default:
        return null;
    }
  }

  private isValidTimestamp(value: string | undefined): value is string {
    return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
  }

  private maxTimestamp(current: string | undefined, candidate: string): string {
    if (!current) return candidate;
    return Date.parse(candidate) >= Date.parse(current) ? candidate : current;
  }
}

const adapter = new CodexSessionAdapter();
registry.register(adapter);
export { CodexSessionAdapter };
export default adapter;
