import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { parseJsonl } from "../utils/parser-helpers.js";
import type { UnifiedSession, SessionMessage, SessionFilter } from "../types/index.js";

type ZcodeContentBlock = {
  type?: string;
  text?: string;
};

type ZcodeMessageEntry = {
  role?: string;
  type?: string;
  content?: string | ZcodeContentBlock[];
  text?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | ZcodeContentBlock[];
  };
};

type ZcodeSessionFile = {
  id?: string;
  title?: string;
  projectPath?: string;
  cwd?: string;
  startedAt?: string;
  updatedAt?: string;
  messages?: ZcodeMessageEntry[];
};

class ZcodeSessionAdapter extends BaseSessionAdapter {
  readonly id = "zcode";
  readonly name = "ZCode";
  readonly command = "zcode";
  readonly storagePaths = [".zcode/sessions", "~/.zcode/sessions"];

  override async detect(): Promise<boolean> {
    if (
      existsSync(resolve(process.cwd(), ".zcode", "sessions")) ||
      existsSync(join(homedir(), ".zcode", "sessions")) ||
      existsSync(join(homedir(), ".zcode"))
    ) {
      return true;
    }
    return this.hasZcodeCommand();
  }

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const dirs = this.resolveExistingSessionDirs();
    if (dirs.length === 0) return [];

    const sessions: UnifiedSession[] = [];
    const seenIds = new Set<string>();

    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }

      for (const file of entries) {
        if (!file.endsWith(".jsonl") && !file.endsWith(".json")) continue;
        const filePath = resolve(dir, file);

        try {
          const fileStat = await stat(filePath);
          if (!fileStat.isFile()) continue;

          const raw = await readFile(filePath, "utf-8");
          const parsed = file.endsWith(".jsonl")
            ? this.parseJsonlSession(file, raw)
            : this.parseJsonSession(file, raw);

          if (!parsed || parsed.messages.length === 0) continue;

          const baseName = basename(file, file.endsWith(".jsonl") ? ".jsonl" : ".json");
          const sessionId = parsed.id ?? `zcode-${baseName}`;
          if (seenIds.has(sessionId)) continue;
          seenIds.add(sessionId);

          const title = this.resolveSessionTitle(parsed.title, parsed.messages);
          sessions.push({
            id: sessionId,
            tool: this.id,
            toolName: this.name,
            title,
            projectPath: parsed.projectPath,
            startedAt: parsed.startedAt ?? fileStat.birthtime.toISOString(),
            updatedAt: parsed.updatedAt ?? fileStat.mtime.toISOString(),
            messageCount: parsed.messages.length,
            messages: parsed.messages,
          });
        } catch {
          // Skip unreadable or malformed files
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

  private resolveExistingSessionDirs(): string[] {
    const candidates = [
      resolve(process.cwd(), ".zcode", "sessions"),
      join(homedir(), ".zcode", "sessions"),
    ];
    const unique = new Set<string>();
    for (const candidate of candidates) {
      if (existsSync(candidate)) unique.add(candidate);
    }
    return [...unique];
  }

  private parseJsonlSession(
    _file: string,
    raw: string,
  ): {
    id?: string;
    title?: string;
    projectPath?: string;
    startedAt?: string;
    updatedAt?: string;
    messages: SessionMessage[];
  } {
    const entries = parseJsonl<ZcodeMessageEntry>(raw);
    const messages = this.extractMessages(entries);
    return { messages };
  }

  private parseJsonSession(
    _file: string,
    raw: string,
  ): {
    id?: string;
    title?: string;
    projectPath?: string;
    startedAt?: string;
    updatedAt?: string;
    messages: SessionMessage[];
  } | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (Array.isArray(parsed)) {
      return { messages: this.extractMessages(parsed as ZcodeMessageEntry[]) };
    }

    if (parsed && typeof parsed === "object") {
      const data = parsed as ZcodeSessionFile;
      if (!Array.isArray(data.messages)) return null;
      return {
        id: typeof data.id === "string" && data.id ? data.id : undefined,
        title: typeof data.title === "string" ? data.title : undefined,
        projectPath:
          typeof data.projectPath === "string"
            ? data.projectPath
            : typeof data.cwd === "string"
              ? data.cwd
              : undefined,
        startedAt: typeof data.startedAt === "string" ? data.startedAt : undefined,
        updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : undefined,
        messages: this.extractMessages(data.messages),
      };
    }

    return null;
  }

  private extractMessages(entries: ZcodeMessageEntry[]): SessionMessage[] {
    const messages: SessionMessage[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const role = this.mapRole(entry);
      if (!role) continue;
      const content = this.extractContent(entry);
      if (!content) continue;
      messages.push({
        role,
        content,
        timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
      });
    }
    return messages;
  }

  private mapRole(entry: ZcodeMessageEntry): SessionMessage["role"] | null {
    const role = entry.role ?? entry.message?.role ?? entry.type;
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

  private extractContent(entry: ZcodeMessageEntry): string | null {
    const raw = entry.content ?? entry.message?.content ?? entry.text;
    if (typeof raw === "string") {
      return raw.length > 0 ? raw : null;
    }
    if (Array.isArray(raw)) {
      const parts = raw
        .filter((block) => block && typeof block === "object" && typeof block.text === "string")
        .map((block) => block.text ?? "")
        .filter((text) => text.length > 0);
      return parts.length > 0 ? parts.join("\n") : null;
    }
    return null;
  }

  private async hasZcodeCommand(): Promise<boolean> {
    const { execFile } = await import("node:child_process");
    const lookupCommand = process.platform === "win32" ? "where" : "which";
    return new Promise((ok) => {
      execFile(lookupCommand, [this.command], (error: Error | null) => {
        ok(!error);
      });
    });
  }
}

const adapter = new ZcodeSessionAdapter();
registry.register(adapter);
export { ZcodeSessionAdapter };
export default adapter;
