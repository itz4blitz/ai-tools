import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { parseJsonl, safeJsonParse } from "../utils/parser-helpers.js";
import type { UnifiedSession, SessionMessage, SessionFilter } from "../types/index.js";

type CopilotTurn = {
  role?: string;
  content?: string;
  type?: string;
  text?: string;
  timestamp?: string;
};

type CopilotLegacySession = {
  id?: string;
  turns?: CopilotTurn[];
  messages?: CopilotTurn[];
  createdAt?: string;
  updatedAt?: string;
};

type CopilotCliEvent = {
  type?: string;
  role?: string;
  content?: string;
  text?: string;
  timestamp?: string;
  data?: {
    sessionId?: string;
    startTime?: string;
    content?: string;
    text?: string;
    context?: { cwd?: string };
  };
};

type VsCodeChatRequest = {
  message?: string | { text?: string };
  response?: string | { value?: string } | Array<string | { value?: string; kind?: string }>;
  timestamp?: number | string;
};

type VsCodeChatSession = {
  sessionId?: string;
  customTitle?: string;
  creationDate?: number | string;
  lastMessageDate?: number | string;
  requests?: VsCodeChatRequest[];
  turns?: CopilotTurn[];
  messages?: CopilotTurn[];
};

export function resolveVsCodeWorkspaceStoragePath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Code", "User", "workspaceStorage");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User", "workspaceStorage");
  }
  return join(home, ".config", "Code", "User", "workspaceStorage");
}

class CopilotSessionAdapter extends BaseSessionAdapter {
  readonly id = "copilot";
  readonly name = "GitHub Copilot";
  readonly command = "copilot";

  get storagePaths(): string[] {
    return [
      "~/.copilot/session-state",
      resolveVsCodeWorkspaceStoragePath(),
      "~/.config/github-copilot",
    ];
  }

  override async detect(): Promise<boolean> {
    if (await this.commandExists("copilot")) return true;
    return this.commandExists("gh");
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

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const home = homedir();
    const sessionsById = new Map<string, UnifiedSession>();

    const cliStateDir = join(home, ".copilot", "session-state");
    if (existsSync(cliStateDir)) {
      for (const session of await this.parseCliSessionState(cliStateDir)) {
        sessionsById.set(session.id, session);
      }
    }

    const vsCodeStorageDir = resolveVsCodeWorkspaceStoragePath(process.platform, process.env, home);
    if (existsSync(vsCodeStorageDir)) {
      for (const session of await this.parseVsCodeWorkspaceStorage(vsCodeStorageDir)) {
        if (!sessionsById.has(session.id)) {
          sessionsById.set(session.id, session);
        }
      }
    }

    const legacyDir = join(home, ".config", "github-copilot");
    if (existsSync(legacyDir)) {
      for (const session of await this.parseLegacySessions(legacyDir)) {
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

  private async parseCliSessionState(rootDir: string): Promise<UnifiedSession[]> {
    const sessions: UnifiedSession[] = [];

    let entries;
    try {
      entries = await readdir(rootDir, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const eventsPath = resolve(rootDir, entry.name, "events.jsonl");
      if (!existsSync(eventsPath)) continue;

      try {
        const content = await readFile(eventsPath, "utf-8");
        const events = parseJsonl<CopilotCliEvent>(content);
        const messages: SessionMessage[] = [];
        let sessionId = `copilot-${entry.name}`;
        let startedAt: string | undefined;
        let updatedAt: string | undefined;
        let projectPath: string | undefined;

        for (const ev of events) {
          if (ev.type === "session.start") {
            if (ev.data?.sessionId) sessionId = ev.data.sessionId;
            if (ev.data?.startTime) startedAt = ev.data.startTime;
            if (ev.data?.context?.cwd) projectPath = ev.data.context.cwd;
          }

          const role = this.mapCliEventRole(ev);
          if (!role) continue;
          const text = ev.data?.content ?? ev.data?.text ?? ev.content ?? ev.text;
          if (typeof text !== "string" || text.length === 0) continue;

          messages.push({ role, content: text, timestamp: ev.timestamp });
          if (ev.timestamp) {
            if (!startedAt) startedAt = ev.timestamp;
            updatedAt = ev.timestamp;
          }
        }

        if (messages.length === 0) continue;

        const fileStat = await stat(eventsPath);
        const title = this.resolveSessionTitle(undefined, messages);

        sessions.push({
          id: sessionId,
          tool: this.id,
          toolName: this.name,
          title,
          projectPath,
          startedAt: startedAt ?? fileStat.birthtime.toISOString(),
          updatedAt: updatedAt ?? fileStat.mtime.toISOString(),
          messageCount: messages.length,
          messages,
        });
      } catch {
        // Skip malformed session files
      }
    }

    return sessions;
  }

  private async parseVsCodeWorkspaceStorage(rootDir: string): Promise<UnifiedSession[]> {
    const sessions: UnifiedSession[] = [];

    let workspaces;
    try {
      workspaces = await readdir(rootDir, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const ws of workspaces) {
      if (!ws.isDirectory()) continue;
      const chatSessionsDir = resolve(rootDir, ws.name, "chatSessions");
      if (!existsSync(chatSessionsDir)) continue;

      let files: string[];
      try {
        files = await readdir(chatSessionsDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".json") && !file.endsWith(".jsonl")) continue;
        const filePath = resolve(chatSessionsDir, file);
        try {
          const content = await readFile(filePath, "utf-8");
          const fileStat = await stat(filePath);
          const session = file.endsWith(".jsonl")
            ? this.parseVsCodeJsonlSession(file, content, fileStat)
            : this.parseVsCodeJsonSession(file, content, fileStat);
          if (session) sessions.push(session);
        } catch {
          // Skip malformed files
        }
      }
    }

    return sessions;
  }

  private parseVsCodeJsonSession(
    file: string,
    content: string,
    fileStat: { birthtime: Date; mtime: Date },
  ): UnifiedSession | null {
    const data = safeJsonParse<VsCodeChatSession>(content, {});
    const messages = this.extractVsCodeMessages(data);
    if (messages.length === 0) return null;

    const sessionId = data.sessionId ?? `copilot-vscode-${basename(file, ".json")}`;
    const title = this.resolveSessionTitle(data.customTitle, messages);

    return {
      id: sessionId,
      tool: this.id,
      toolName: this.name,
      title,
      startedAt: normalizeTimestamp(data.creationDate) ?? fileStat.birthtime.toISOString(),
      updatedAt: normalizeTimestamp(data.lastMessageDate) ?? fileStat.mtime.toISOString(),
      messageCount: messages.length,
      messages,
    };
  }

  private parseVsCodeJsonlSession(
    file: string,
    content: string,
    fileStat: { birthtime: Date; mtime: Date },
  ): UnifiedSession | null {
    const entries = parseJsonl<Record<string, unknown>>(content);
    const messages: SessionMessage[] = [];
    let sessionId: string | undefined;
    let customTitle: string | undefined;
    let startedAt: string | undefined;
    let updatedAt: string | undefined;

    for (const entry of entries) {
      // VS Code chat session JSONL snapshot line: { kind: 0, v: { sessionId, requests, ... } }
      const candidate =
        entry.v && typeof entry.v === "object" && !Array.isArray(entry.v)
          ? (entry.v as VsCodeChatSession)
          : (entry as VsCodeChatSession);

      if (candidate.sessionId) sessionId = candidate.sessionId;
      if (candidate.customTitle) customTitle = candidate.customTitle;
      const created = normalizeTimestamp(candidate.creationDate);
      if (created && !startedAt) startedAt = created;
      const updated = normalizeTimestamp(candidate.lastMessageDate);
      if (updated) updatedAt = updated;

      const extracted = this.extractVsCodeMessages(candidate);
      if (extracted.length > 0) {
        messages.push(...extracted);
        continue;
      }

      // Direct turn/message line fallback
      const turn = entry as CopilotTurn;
      const role = this.mapRole(turn);
      const text = turn.content ?? turn.text;
      if (role && text) {
        messages.push({ role, content: text, timestamp: turn.timestamp });
      }
    }

    if (messages.length === 0) return null;

    return {
      id: sessionId ?? `copilot-vscode-${basename(file, ".jsonl")}`,
      tool: this.id,
      toolName: this.name,
      title: this.resolveSessionTitle(customTitle, messages),
      startedAt: startedAt ?? fileStat.birthtime.toISOString(),
      updatedAt: updatedAt ?? fileStat.mtime.toISOString(),
      messageCount: messages.length,
      messages,
    };
  }

  private extractVsCodeMessages(data: VsCodeChatSession): SessionMessage[] {
    const messages: SessionMessage[] = [];

    if (Array.isArray(data.requests)) {
      for (const req of data.requests) {
        const ts = normalizeTimestamp(req.timestamp);
        const userText = typeof req.message === "string" ? req.message : req.message?.text;
        if (userText) {
          messages.push({ role: "user", content: userText, timestamp: ts });
        }

        const assistantText = extractVsCodeResponseText(req.response);
        if (assistantText) {
          messages.push({ role: "assistant", content: assistantText, timestamp: ts });
        }
      }
    }

    const turns = data.turns ?? data.messages ?? [];
    for (const turn of turns) {
      const role = this.mapRole(turn);
      if (!role) continue;
      const text = turn.content ?? turn.text;
      if (text) {
        messages.push({ role, content: text, timestamp: turn.timestamp });
      }
    }

    return messages;
  }

  private async parseLegacySessions(storagePath: string): Promise<UnifiedSession[]> {
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
        const data = safeJsonParse<CopilotLegacySession>(content, {});

        const turns = data.turns ?? data.messages ?? [];
        const messages: SessionMessage[] = [];

        for (const turn of turns) {
          const role = this.mapRole(turn);
          if (!role) continue;
          const text = turn.content ?? turn.text;
          if (text) {
            messages.push({
              role,
              content: text,
              timestamp: turn.timestamp,
            });
          }
        }

        if (messages.length === 0) continue;

        const fileStat = await stat(filePath);
        const sessionId = data.id ?? `copilot-${file.replace(".json", "")}`;
        const title = this.resolveSessionTitle(undefined, messages);

        sessions.push({
          id: sessionId,
          tool: this.id,
          toolName: this.name,
          title,
          startedAt: data.createdAt ?? fileStat.birthtime.toISOString(),
          updatedAt: data.updatedAt ?? fileStat.mtime.toISOString(),
          messageCount: messages.length,
          messages,
        });
      } catch {
        // Skip malformed files
      }
    }

    return sessions;
  }

  private mapCliEventRole(ev: CopilotCliEvent): SessionMessage["role"] | null {
    switch (ev.type) {
      case "user.message":
        return "user";
      case "assistant.message":
        return "assistant";
      case "system.message":
        return "system";
      case "tool.result":
        return "tool";
      default:
        return this.mapRole(ev);
    }
  }

  private mapRole(turn: CopilotTurn): SessionMessage["role"] | null {
    const role = turn.role ?? turn.type;
    switch (role) {
      case "user":
      case "human":
        return "user";
      case "assistant":
      case "copilot":
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

function extractVsCodeResponseText(response: VsCodeChatRequest["response"]): string {
  if (!response) return "";
  if (typeof response === "string") return response;
  if (Array.isArray(response)) {
    return response
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.value === "string") {
          return part.value;
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return typeof response === "object" && typeof response.value === "string" ? response.value : "";
}

function normalizeTimestamp(value: number | string | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

const adapter = new CopilotSessionAdapter();
registry.register(adapter);
export { CopilotSessionAdapter };
export default adapter;
