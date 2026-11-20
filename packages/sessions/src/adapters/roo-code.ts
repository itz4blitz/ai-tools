import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";
import { safeJsonParse } from "../utils/parser-helpers.js";
import type { UnifiedSession, SessionMessage, SessionFilter } from "../types/index.js";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROO_EXTENSION_ID = "rooveterinaryinc.roo-cline";

type RooContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  content?: string | Array<{ type?: string; text?: string }>;
};

type RooApiMessage = {
  role?: string;
  content?: string | RooContentBlock[];
  ts?: number;
};

type RooHistoryItem = {
  id?: string;
  ts?: number;
  task?: string;
  workspace?: string;
  cwd?: string;
  mode?: string;
  tokensIn?: number;
  tokensOut?: number;
  totalCost?: number;
};

type RooTaskMetadata = {
  files_in_context?: Array<{
    path?: string;
    record_state?: string;
    record_source?: string;
  }>;
  model_usage?: unknown[];
};

export function resolveRooCodeTasksPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Code", "User", "globalStorage", ROO_EXTENSION_ID, "tasks");
  }

  if (platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      ROO_EXTENSION_ID,
      "tasks",
    );
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return join(xdgConfigHome, "Code", "User", "globalStorage", ROO_EXTENSION_ID, "tasks");
}

class RooCodeSessionAdapter extends BaseSessionAdapter {
  readonly id = "roo-code";
  readonly name = "Roo Code";
  readonly command = "code";
  readonly storagePaths: string[];

  constructor(storagePaths?: string[]) {
    super();
    this.storagePaths = storagePaths ?? [resolveRooCodeTasksPath()];
  }

  override async detect(): Promise<boolean> {
    return (await this.getStoragePath()) !== null;
  }

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const storagePath = await this.getStoragePath();
    if (!storagePath) return [];

    let taskDirs;
    try {
      taskDirs = await readdir(storagePath, { withFileTypes: true });
    } catch {
      return [];
    }

    const sessions: UnifiedSession[] = [];

    for (const entry of taskDirs) {
      if (!entry.isDirectory()) continue;
      const taskDir = resolve(storagePath, entry.name);
      try {
        const session = await this.parseTaskDir(taskDir, entry.name);
        if (session) sessions.push(session);
      } catch {
        // Skip malformed task directories
      }
    }

    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    if (filter) {
      const { filterSessions } = await import("../utils/index.js");
      return filterSessions(sessions, filter);
    }

    return sessions;
  }

  private async parseTaskDir(taskDir: string, taskId: string): Promise<UnifiedSession | null> {
    const historyFile = resolve(taskDir, "api_conversation_history.json");
    if (!existsSync(historyFile)) return null;

    const rawHistory = await readFile(historyFile, "utf-8");
    const parsedHistory = safeJsonParse<unknown>(rawHistory, null);
    if (!Array.isArray(parsedHistory)) return null;

    const messages: SessionMessage[] = [];
    const timestamps: number[] = [];

    for (const entry of parsedHistory as RooApiMessage[]) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.ts === "number" && Number.isFinite(entry.ts)) {
        timestamps.push(entry.ts);
      }
      const extracted = this.extractMessage(entry);
      if (extracted) messages.push(extracted);
    }

    if (messages.length === 0) return null;

    const historyItem = await this.readOptionalJson<RooHistoryItem>(
      resolve(taskDir, "history_item.json"),
    );
    const taskMetadata = await this.readOptionalJson<RooTaskMetadata>(
      resolve(taskDir, "task_metadata.json"),
    );

    const fileStat = await stat(historyFile);
    const firstTs = historyItem?.ts ?? timestamps[0];
    const lastTs = timestamps[timestamps.length - 1] ?? historyItem?.ts;

    const startedAt =
      typeof firstTs === "number"
        ? new Date(firstTs).toISOString()
        : fileStat.birthtime.toISOString();
    const updatedAt =
      typeof lastTs === "number" ? new Date(lastTs).toISOString() : fileStat.mtime.toISOString();

    const sessionId = `roo-code-${historyItem?.id ?? taskId}`;
    const rawTitle =
      historyItem?.task ?? stripTaskTags(messages.find((m) => m.role === "user")?.content);
    const title = this.resolveSessionTitle(rawTitle, messages);
    const projectPath = historyItem?.workspace ?? historyItem?.cwd;

    const metadata: Record<string, unknown> = {};
    if (historyItem?.mode) metadata.mode = historyItem.mode;
    if (typeof historyItem?.tokensIn === "number") metadata.tokensIn = historyItem.tokensIn;
    if (typeof historyItem?.tokensOut === "number") metadata.tokensOut = historyItem.tokensOut;
    if (typeof historyItem?.totalCost === "number") metadata.totalCost = historyItem.totalCost;

    const filesInContext = (taskMetadata?.files_in_context ?? [])
      .map((f) => f.path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    if (filesInContext.length > 0) {
      metadata.filesInContext = filesInContext;
    }

    return {
      id: sessionId,
      tool: this.id,
      toolName: this.name,
      title,
      projectPath,
      startedAt,
      updatedAt,
      messageCount: messages.length,
      messages,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }

  private async readOptionalJson<T>(filePath: string): Promise<T | null> {
    if (!existsSync(filePath)) return null;
    try {
      const raw = await readFile(filePath, "utf-8");
      const parsed = safeJsonParse<T | null>(raw, null);
      return parsed !== null && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  private extractMessage(entry: RooApiMessage): SessionMessage | null {
    const timestamp =
      typeof entry.ts === "number" && Number.isFinite(entry.ts)
        ? new Date(entry.ts).toISOString()
        : undefined;

    if (typeof entry.content === "string") {
      const role = this.mapRole(entry.role);
      const content = entry.content.trim();
      if (!role || !content) return null;
      return { role, content, ...(timestamp ? { timestamp } : {}) };
    }

    if (!Array.isArray(entry.content)) return null;

    const textParts: string[] = [];
    const toolResultParts: string[] = [];
    let toolName: string | undefined;

    for (const block of entry.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        textParts.push(block.text.trim());
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        toolName = toolName ?? block.name;
      } else if (block.type === "tool_result") {
        const resultText = extractToolResultText(block.content);
        if (resultText) toolResultParts.push(resultText);
      }
    }

    if (textParts.length > 0) {
      const role = this.mapRole(entry.role);
      if (!role) return null;
      return {
        role,
        content: textParts.join("\n"),
        ...(timestamp ? { timestamp } : {}),
        ...(toolName ? { toolName } : {}),
      };
    }

    if (toolResultParts.length > 0) {
      return {
        role: "tool",
        content: toolResultParts.join("\n"),
        ...(timestamp ? { timestamp } : {}),
      };
    }

    if (toolName && entry.role === "assistant") {
      return {
        role: "assistant",
        content: `[tool_use: ${toolName}]`,
        toolName,
        ...(timestamp ? { timestamp } : {}),
      };
    }

    return null;
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

function extractToolResultText(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && item.type === "text" && typeof item.text === "string" && item.text.trim()) {
        parts.push(item.text.trim());
      }
    }
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

function stripTaskTags(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = /<task>([\s\S]*?)<\/task>/i.exec(text);
  return match?.[1]?.trim() || text;
}

const adapter = new RooCodeSessionAdapter();
registry.register(adapter);
export { RooCodeSessionAdapter };
export default adapter;
