import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { parseJsonl } from "../utils/parser-helpers.js";
import type { UnifiedSession, SessionMessage, SessionFilter } from "../types/index.js";

type ClaudeContentBlock = {
  type: string;
  text?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

type ClaudeMessage = {
  type: string;
  cwd?: string;
  timestamp?: string | number;
  message?: {
    role?: string;
    content: string | ClaudeContentBlock[];
  };
};

class ClaudeSessionAdapter extends BaseSessionAdapter {
  readonly id = "claude";
  readonly name = "Claude Code";
  readonly command = "claude";
  readonly storagePaths = ["~/.claude/projects"];

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const storagePath = await this.getStoragePath();
    if (!storagePath) return [];

    const { readdir, readFile, stat } = await import("node:fs/promises");
    const { resolve } = await import("node:path");

    const sessions: UnifiedSession[] = [];

    let projectDirs: string[];
    try {
      projectDirs = await readdir(storagePath);
    } catch {
      return [];
    }

    for (const projectDir of projectDirs) {
      const projectPath = resolve(storagePath, projectDir);

      let dirStat;
      try {
        dirStat = await stat(projectPath);
      } catch {
        continue;
      }
      if (!dirStat.isDirectory()) continue;

      let files: string[];
      try {
        files = await readdir(projectPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = resolve(projectPath, file);

        try {
          const content = await readFile(filePath, "utf-8");
          const entries = parseJsonl<ClaudeMessage>(content);

          const messages: SessionMessage[] = [];
          let resolvedProjectPath: string | undefined;
          let earliestTs: number | undefined;
          let latestTs: number | undefined;

          for (const entry of entries) {
            if (!resolvedProjectPath && typeof entry.cwd === "string" && entry.cwd.trim()) {
              resolvedProjectPath = entry.cwd.trim();
            }

            const entryTs = this.parseTimestamp(entry.timestamp);
            if (entryTs !== undefined) {
              if (earliestTs === undefined || entryTs < earliestTs) earliestTs = entryTs;
              if (latestTs === undefined || entryTs > latestTs) latestTs = entryTs;
            }

            const baseRole = this.mapRole(entry.type);
            if (!baseRole) continue;

            const extracted = this.extractContent(entry);
            if (!extracted) continue;

            const role = baseRole === "user" && extracted.onlyToolResults ? "tool" : baseRole;
            const message: SessionMessage = {
              role,
              content: extracted.text,
              ...(entryTs !== undefined ? { timestamp: new Date(entryTs).toISOString() } : {}),
            };
            messages.push(message);
          }

          if (messages.length === 0) continue;

          const fileStat = await stat(filePath);
          const sessionId = `claude-${projectDir}-${file.replace(".jsonl", "")}`;
          const title = this.resolveSessionTitle(undefined, messages);

          sessions.push({
            id: sessionId,
            tool: this.id,
            toolName: this.name,
            title,
            projectPath: resolvedProjectPath ?? projectDir,
            startedAt:
              earliestTs !== undefined
                ? new Date(earliestTs).toISOString()
                : fileStat.birthtime.toISOString(),
            updatedAt:
              latestTs !== undefined
                ? new Date(latestTs).toISOString()
                : fileStat.mtime.toISOString(),
            messageCount: messages.length,
            messages,
          });
        } catch {
          // Skip malformed files
        }
      }
    }

    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    if (filter) {
      const { filterSessions } = await import("../utils/index.js");
      return filterSessions(sessions, filter);
    }

    return sessions;
  }

  private mapRole(type: string): SessionMessage["role"] | null {
    switch (type) {
      case "user":
      case "human":
        return "user";
      case "assistant":
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

  private parseTimestamp(value: string | number | undefined): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  private extractContent(entry: ClaudeMessage): { text: string; onlyToolResults: boolean } | null {
    const msg = entry.message;
    if (!msg) return null;

    if (typeof msg.content === "string") {
      return msg.content ? { text: msg.content, onlyToolResults: false } : null;
    }

    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      let hasText = false;
      let hasToolResult = false;

      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          parts.push(part.text);
          hasText = true;
        } else if (part.type === "tool_result") {
          const resultText = this.extractToolResultText(part.content);
          if (resultText) {
            parts.push(resultText);
            hasToolResult = true;
          }
        }
      }

      if (parts.length === 0) return null;
      return {
        text: parts.join("\n"),
        onlyToolResults: hasToolResult && !hasText,
      };
    }

    return null;
  }

  private extractToolResultText(
    content: string | Array<{ type?: string; text?: string }> | undefined,
  ): string | null {
    if (typeof content === "string") {
      return content || null;
    }
    if (Array.isArray(content)) {
      const texts = content
        .filter((item) => item.type === "text" && typeof item.text === "string" && item.text)
        .map((item) => item.text ?? "");
      return texts.length > 0 ? texts.join("\n") : null;
    }
    return null;
  }
}

const adapter = new ClaudeSessionAdapter();
registry.register(adapter);
export { ClaudeSessionAdapter };
export default adapter;
