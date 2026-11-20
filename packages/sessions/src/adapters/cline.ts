import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { safeJsonParse } from "../utils/parser-helpers.js";
import type { UnifiedSession, SessionMessage, SessionFilter } from "../types/index.js";

type ClineHistoryItem = {
  id?: string;
  ts?: number;
  task?: string;
  tokensIn?: number;
  tokensOut?: number;
  totalCost?: number;
  cwdOnTaskInitialization?: string;
};

type ClineApiContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: string | Array<{ type?: string; text?: string }>;
};

type ClineApiMessage = {
  role?: string;
  content?: string | ClineApiContentBlock[];
};

type ClineUiMessage = {
  ts?: number;
  type?: "say" | "ask";
  say?: string;
  ask?: string;
  text?: string;
};

export type ResolveClineSessionRootsOptions = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Return candidate Cline data roots (VS Code globalStorage + Cline CLI `~/.cline/data`).
 */
export function getClineSessionStoragePaths(
  options: ResolveClineSessionRootsOptions = {},
): string[] {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;

  let vscodeRoot: string;
  if (platform === "darwin") {
    vscodeRoot = join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev",
    );
  } else if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    vscodeRoot = join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  } else {
    const xdgConfig = env.XDG_CONFIG_HOME ?? join(home, ".config");
    vscodeRoot = join(xdgConfig, "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  }

  const cliRoot = join(home, ".cline", "data");
  return [vscodeRoot, cliRoot];
}

class ClineSessionAdapter extends BaseSessionAdapter {
  readonly id = "cline";
  readonly name = "Cline";
  readonly command = "cline";
  readonly storagePaths: string[];

  constructor(storagePaths?: string[]) {
    super();
    this.storagePaths = storagePaths ?? getClineSessionStoragePaths();
  }

  override async detect(): Promise<boolean> {
    if ((await this.getStoragePath()) !== null) return true;
    const { execFile } = await import("node:child_process");
    const lookupCommand = process.platform === "win32" ? "where" : "which";
    return new Promise((ok) => {
      execFile(lookupCommand, [this.command], (error: Error | null) => {
        ok(!error);
      });
    });
  }

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const sessionsByTaskId = new Map<string, UnifiedSession>();

    for (const rawRoot of this.storagePaths) {
      const root = rawRoot.replace(/^~(?=$|[\\/])/, homedir());
      if (!existsSync(root)) continue;

      const historyMap = await this.readTaskHistory(root);
      const tasksDir = resolve(root, "tasks");
      if (!existsSync(tasksDir)) continue;

      let entries;
      try {
        entries = await readdir(tasksDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const taskId = entry.name;
        if (sessionsByTaskId.has(taskId)) continue;

        const taskDir = resolve(tasksDir, taskId);
        const session = await this.parseTaskDir(taskDir, taskId, historyMap.get(taskId));
        if (session) {
          sessionsByTaskId.set(taskId, session);
        }
      }
    }

    const sessions = [...sessionsByTaskId.values()];
    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    if (filter) {
      const { filterSessions } = await import("../utils/index.js");
      return filterSessions(sessions, filter);
    }

    return sessions;
  }

  private async readTaskHistory(root: string): Promise<Map<string, ClineHistoryItem>> {
    const map = new Map<string, ClineHistoryItem>();
    const historyPath = resolve(root, "state", "taskHistory.json");
    if (!existsSync(historyPath)) return map;

    try {
      const raw = await readFile(historyPath, "utf-8");
      const items = safeJsonParse<ClineHistoryItem[]>(raw, []);
      if (!Array.isArray(items)) return map;
      for (const item of items) {
        if (typeof item?.id === "string" && item.id.length > 0) {
          map.set(item.id, item);
        }
      }
    } catch {
      // Ignore malformed taskHistory.json
    }

    return map;
  }

  private async parseTaskDir(
    taskDir: string,
    taskId: string,
    historyItem?: ClineHistoryItem,
  ): Promise<UnifiedSession | null> {
    const apiPath = resolve(taskDir, "api_conversation_history.json");
    const uiPath = resolve(taskDir, "ui_messages.json");

    let uiMessages: ClineUiMessage[] = [];
    if (existsSync(uiPath)) {
      try {
        const rawUi = await readFile(uiPath, "utf-8");
        const parsed = safeJsonParse<ClineUiMessage[]>(rawUi, []);
        if (Array.isArray(parsed)) uiMessages = parsed;
      } catch {
        // Ignore malformed ui_messages.json
      }
    }

    let messages: SessionMessage[] = [];
    if (existsSync(apiPath)) {
      try {
        const rawApi = await readFile(apiPath, "utf-8");
        const parsed = safeJsonParse<ClineApiMessage[]>(rawApi, []);
        if (Array.isArray(parsed)) {
          messages = this.parseApiMessages(parsed);
        }
      } catch {
        // Fall through to ui_messages.json
      }
    }

    if (messages.length === 0 && uiMessages.length > 0) {
      messages = this.parseUiMessages(uiMessages);
    }

    if (messages.length === 0) return null;

    const dirStat = await stat(taskDir);
    const uiTimestamps = uiMessages
      .map((m) => m.ts)
      .filter((ts): ts is number => typeof ts === "number" && Number.isFinite(ts));

    const firstTs = uiTimestamps.length > 0 ? Math.min(...uiTimestamps) : historyItem?.ts;
    const lastTs = uiTimestamps.length > 0 ? Math.max(...uiTimestamps) : historyItem?.ts;

    const startedAt =
      firstTs !== undefined ? new Date(firstTs).toISOString() : dirStat.birthtime.toISOString();
    const updatedAt =
      lastTs !== undefined ? new Date(lastTs).toISOString() : dirStat.mtime.toISOString();

    const title = this.resolveSessionTitle(historyItem?.task, messages);
    const metadata: Record<string, unknown> = {};
    if (typeof historyItem?.tokensIn === "number") metadata.tokensIn = historyItem.tokensIn;
    if (typeof historyItem?.tokensOut === "number") metadata.tokensOut = historyItem.tokensOut;
    if (typeof historyItem?.totalCost === "number") metadata.totalCost = historyItem.totalCost;

    return {
      id: `cline-${taskId}`,
      tool: this.id,
      toolName: this.name,
      title,
      projectPath: historyItem?.cwdOnTaskInitialization,
      startedAt,
      updatedAt,
      messageCount: messages.length,
      messages,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }

  private parseApiMessages(entries: ClineApiMessage[]): SessionMessage[] {
    const messages: SessionMessage[] = [];

    for (const entry of entries) {
      const role = this.mapApiRole(entry.role);
      if (!role) continue;

      if (typeof entry.content === "string") {
        const text = entry.content.trim();
        if (text) messages.push({ role, content: text });
        continue;
      }

      if (!Array.isArray(entry.content)) continue;

      const textParts: string[] = [];
      for (const block of entry.content) {
        if (!block || typeof block !== "object") continue;

        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          textParts.push(block.text.trim());
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          messages.push({
            role: "tool",
            toolName: block.name,
            content:
              block.input !== undefined ? JSON.stringify(block.input) : `Called ${block.name}`,
          });
        } else if (block.type === "tool_result") {
          const resultText = this.extractToolResultText(block.content);
          if (resultText) {
            messages.push({ role: "tool", content: resultText });
          }
        }
      }

      if (textParts.length > 0) {
        messages.push({ role, content: textParts.join("\n") });
      }
    }

    return messages;
  }

  private parseUiMessages(entries: ClineUiMessage[]): SessionMessage[] {
    const messages: SessionMessage[] = [];

    for (const entry of entries) {
      const text = typeof entry.text === "string" ? entry.text.trim() : "";
      if (!text) continue;

      const timestamp =
        typeof entry.ts === "number" && Number.isFinite(entry.ts)
          ? new Date(entry.ts).toISOString()
          : undefined;

      if (entry.type === "say") {
        if (entry.say === "task" || entry.say === "user_feedback") {
          messages.push({ role: "user", content: text, timestamp });
        } else if (entry.say === "text" || entry.say === "completion_result") {
          messages.push({ role: "assistant", content: text, timestamp });
        }
      } else if (entry.type === "ask" && entry.ask === "tool") {
        messages.push({ role: "tool", content: text, timestamp });
      }
    }

    return messages;
  }

  private extractToolResultText(content: ClineApiContentBlock["content"]): string {
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part?.text === "string" ? part.text.trim() : ""))
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

  private mapApiRole(role?: string): SessionMessage["role"] | null {
    switch (role) {
      case "user":
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

const adapter = new ClineSessionAdapter();
registry.register(adapter);
export { ClineSessionAdapter };
export default adapter;
