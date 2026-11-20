import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { parseJsonl } from "../utils/parser-helpers.js";
import type { SessionFilter, SessionMessage, UnifiedSession } from "../types/index.js";

type ContentPart = {
  type?: string;
  text?: string;
};

type DroidJsonlEntry = {
  type?: string;
  id?: string;
  title?: string;
  cwd?: string;
  role?: string;
  content?: string | ContentPart[];
  text?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | ContentPart[];
    timestamp?: string;
  };
};

class DroidSessionAdapter extends BaseSessionAdapter {
  readonly id = "droid";
  readonly name = "Factory Droid";
  readonly command = "droid";
  readonly storagePaths = ["~/.factory/sessions", "~/.factory/projects"];

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const { existsSync } = await import("node:fs");
    const { readdir, readFile, stat } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { resolve } = await import("node:path");

    const roots = this.storagePaths
      .map((p) => p.replace("~", homedir()))
      .filter((p) => existsSync(p));

    if (roots.length === 0) return [];

    const sessions: UnifiedSession[] = [];
    const seenIds = new Set<string>();

    const collectFile = async (filePath: string, fileName: string, projectDir?: string) => {
      try {
        const content = await readFile(filePath, "utf-8");
        const entries = parseJsonl<DroidJsonlEntry>(content);

        let explicitId: string | undefined;
        let explicitTitle: string | undefined;
        let explicitCwd: string | undefined;
        const messages: SessionMessage[] = [];

        for (const entry of entries) {
          if (entry.type === "session_start") {
            if (typeof entry.id === "string" && entry.id.trim()) {
              explicitId = entry.id.trim();
            }
            if (typeof entry.title === "string" && entry.title.trim()) {
              explicitTitle = entry.title.trim();
            }
            if (typeof entry.cwd === "string" && entry.cwd.trim()) {
              explicitCwd = entry.cwd.trim();
            }
            continue;
          }

          if (entry.type === "message" && entry.message) {
            const role = this.mapRole(entry.message.role);
            if (!role) continue;
            const text = this.extractContent(entry.message.content);
            if (text) {
              messages.push({
                role,
                content: text,
                timestamp: entry.timestamp ?? entry.message.timestamp,
              });
            }
            continue;
          }

          // Fallback for flat entries
          const role = this.mapRole(entry.role ?? entry.type);
          if (!role) continue;
          const text =
            this.extractContent(entry.content) ??
            (typeof entry.text === "string" ? entry.text : null);
          if (text) {
            messages.push({
              role,
              content: text,
              timestamp: entry.timestamp,
            });
          }
        }

        if (messages.length === 0) return;

        const fileStat = await stat(filePath);
        const rawId = explicitId ?? fileName.replace(/\.jsonl$/, "");
        const sessionId = rawId.startsWith("droid-") ? rawId : `droid-${rawId}`;
        if (seenIds.has(sessionId)) return;
        seenIds.add(sessionId);

        const title = this.resolveSessionTitle(explicitTitle, messages);
        const projectPath = explicitCwd ?? projectDir;

        sessions.push({
          id: sessionId,
          tool: this.id,
          toolName: this.name,
          title,
          ...(projectPath ? { projectPath } : {}),
          startedAt: fileStat.birthtime.toISOString(),
          updatedAt: fileStat.mtime.toISOString(),
          messageCount: messages.length,
          messages,
        });
      } catch {
        // Skip malformed files
      }
    };

    for (const storageRoot of roots) {
      let entries;
      try {
        entries = await readdir(storageRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const entryPath = resolve(storageRoot, entry.name);
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          await collectFile(entryPath, entry.name);
        } else if (entry.isDirectory()) {
          let subEntries;
          try {
            subEntries = await readdir(entryPath, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const subEntry of subEntries) {
            if (!subEntry.isFile() || !subEntry.name.endsWith(".jsonl")) continue;
            await collectFile(resolve(entryPath, subEntry.name), subEntry.name, entry.name);
          }
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
      case "tool_result":
        return "tool";
      default:
        return null;
    }
  }

  private extractContent(content?: string | ContentPart[]): string | null {
    if (typeof content === "string") {
      return content.length > 0 ? content : null;
    }

    if (Array.isArray(content)) {
      const textParts = content
        .filter(
          (part) =>
            part && part.type === "text" && typeof part.text === "string" && part.text.length > 0,
        )
        .map((part) => part.text ?? "");
      return textParts.length > 0 ? textParts.join("\n") : null;
    }

    return null;
  }
}

const adapter = new DroidSessionAdapter();
registry.register(adapter);
export { DroidSessionAdapter };
export default adapter;
