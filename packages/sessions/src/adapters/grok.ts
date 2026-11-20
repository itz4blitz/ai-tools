import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { parseJsonl, safeJsonParse } from "../utils/parser-helpers.js";
import type { SessionFilter, SessionMessage, UnifiedSession } from "../types/index.js";

type GrokMessageContent = string | Array<{ type?: string; text?: string }>;

type GrokMessage = {
  role?: string;
  type?: string;
  content?: GrokMessageContent;
  text?: string;
  message?: {
    role?: string;
    content?: GrokMessageContent;
  };
  timestamp?: string;
  toolName?: string;
};

type GrokSessionFile = {
  id?: string;
  title?: string;
  projectPath?: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  messages?: GrokMessage[];
  history?: GrokMessage[];
};

class GrokSessionAdapter extends BaseSessionAdapter {
  readonly id = "grok";
  readonly name = "Grok";
  readonly command = "grok";
  readonly storagePaths = [".grok/sessions", "~/.grok/sessions"];

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const dirs = this.resolveStorageDirs();
    if (dirs.length === 0) return [];

    const sessions: UnifiedSession[] = [];
    const seenIds = new Set<string>();

    for (const dir of dirs) {
      let files: string[];
      try {
        files = (await readdir(dir)).toSorted();
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".jsonl") && !file.endsWith(".json")) continue;
        const filePath = resolve(dir, file);

        try {
          const parsed = await this.parseSessionFile(filePath, file);
          if (!parsed || seenIds.has(parsed.id)) continue;
          seenIds.add(parsed.id);
          sessions.push(parsed);
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

  private resolveStorageDirs(): string[] {
    const home = homedir();
    const dirs = new Set<string>();
    for (const p of this.storagePaths) {
      const resolved = p.startsWith("~/") ? join(home, p.slice(2)) : resolve(process.cwd(), p);
      if (existsSync(resolved)) {
        dirs.add(resolved);
      }
    }
    return [...dirs];
  }

  private async parseSessionFile(
    filePath: string,
    fileName: string,
  ): Promise<UnifiedSession | null> {
    const content = await readFile(filePath, "utf-8");
    const fileStat = await stat(filePath);

    if (fileName.endsWith(".jsonl")) {
      const entries = parseJsonl<GrokMessage>(content);
      const messages = this.extractMessages(entries);
      if (messages.length === 0) return null;

      const sessionId = `grok-${basename(fileName, ".jsonl")}`;
      return {
        id: sessionId,
        tool: this.id,
        toolName: this.name,
        title: this.resolveSessionTitle(undefined, messages),
        startedAt: fileStat.birthtime.toISOString(),
        updatedAt: fileStat.mtime.toISOString(),
        messageCount: messages.length,
        messages,
      };
    }

    const data = safeJsonParse<GrokSessionFile>(content, {});
    const entries = data.messages ?? data.history ?? [];
    const messages = this.extractMessages(entries);
    if (messages.length === 0) return null;

    const sessionId = data.id ?? `grok-${basename(fileName, ".json")}`;
    return {
      id: sessionId,
      tool: this.id,
      toolName: this.name,
      title: this.resolveSessionTitle(data.title, messages),
      projectPath: data.projectPath ?? data.cwd,
      startedAt: data.createdAt ?? fileStat.birthtime.toISOString(),
      updatedAt: data.updatedAt ?? fileStat.mtime.toISOString(),
      messageCount: messages.length,
      messages,
    };
  }

  private extractMessages(entries: GrokMessage[]): SessionMessage[] {
    const messages: SessionMessage[] = [];
    for (const entry of entries) {
      const role = this.mapRole(entry);
      if (!role) continue;
      const text = this.extractContent(entry);
      if (!text) continue;
      const msg: SessionMessage = { role, content: text };
      if (entry.timestamp) msg.timestamp = entry.timestamp;
      if (entry.toolName) msg.toolName = entry.toolName;
      messages.push(msg);
    }
    return messages;
  }

  private mapRole(entry: GrokMessage): SessionMessage["role"] | null {
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

  private extractContent(entry: GrokMessage): string | null {
    const raw = entry.content ?? entry.message?.content ?? entry.text;
    if (typeof raw === "string") {
      return raw.length > 0 ? raw : null;
    }
    if (Array.isArray(raw)) {
      const textParts = raw
        .filter((part) => (part.type === undefined || part.type === "text") && part.text)
        .map((part) => part.text ?? "");
      return textParts.length > 0 ? textParts.join("\n") : null;
    }
    return null;
  }
}

const adapter = new GrokSessionAdapter();
registry.register(adapter);
export { GrokSessionAdapter };
export default adapter;
