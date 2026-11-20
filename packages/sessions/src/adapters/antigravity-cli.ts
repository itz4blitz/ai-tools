import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionFilter, SessionMessage, UnifiedSession } from "../types/index.js";
import { parseJsonl } from "../utils/parser-helpers.js";
import { BaseSessionAdapter } from "./base.js";
import { registry } from "./registry.js";

type AntigravityTranscriptStep = {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
};

export class AntigravityCliSessionAdapter extends BaseSessionAdapter {
  readonly id = "antigravity-cli";
  readonly name = "Antigravity CLI";
  readonly command = "agy";
  readonly storagePaths = ["~/.gemini/antigravity-cli/brain", "~/.gemini/antigravity/brain"];

  override async detect(): Promise<boolean> {
    if ((await this.getStoragePath()) !== null) return true;
    if (existsSync(join(homedir(), ".gemini", "antigravity-cli", "settings.json"))) return true;
    return this.commandExistsCrossPlatform(this.command);
  }

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    const roots = this.storagePaths
      .map((p) => p.replace(/^~/, homedir()))
      .filter((p) => existsSync(p));
    if (roots.length === 0) return [];

    const sessions: UnifiedSession[] = [];
    const seenIds = new Set<string>();

    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (seenIds.has(entry.name)) continue;

        const transcriptPath = resolve(
          root,
          entry.name,
          ".system_generated",
          "logs",
          "transcript.jsonl",
        );
        if (!existsSync(transcriptPath)) continue;

        try {
          const content = await readFile(transcriptPath, "utf-8");
          const steps = parseJsonl<AntigravityTranscriptStep>(content);
          const messages: SessionMessage[] = [];
          let firstTimestamp: string | undefined;
          let lastTimestamp: string | undefined;

          for (const step of steps) {
            if (step.created_at) {
              if (!firstTimestamp) firstTimestamp = step.created_at;
              lastTimestamp = step.created_at;
            }
            const role = mapStepRole(step.type);
            if (!role) continue;
            const text = typeof step.content === "string" ? step.content.trim() : "";
            if (!text) continue;
            messages.push({
              role,
              content: text,
              timestamp: step.created_at,
            });
          }

          if (messages.length === 0) continue;

          const fileStat = await stat(transcriptPath);
          const title = this.resolveSessionTitle(undefined, messages);

          seenIds.add(entry.name);
          sessions.push({
            id: entry.name,
            tool: this.id,
            toolName: this.name,
            title,
            startedAt: firstTimestamp ?? fileStat.birthtime.toISOString(),
            updatedAt: lastTimestamp ?? fileStat.mtime.toISOString(),
            messageCount: messages.length,
            messages,
          });
        } catch {
          // Skip unreadable or malformed transcripts
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

  private async commandExistsCrossPlatform(command: string): Promise<boolean> {
    const { execFile } = await import("node:child_process");
    const lookupCommand = process.platform === "win32" ? "where" : "which";
    return new Promise((ok) => {
      execFile(lookupCommand, [command], (error) => {
        ok(!error);
      });
    });
  }
}

function mapStepRole(stepType: string | undefined): SessionMessage["role"] | null {
  switch (stepType) {
    case "USER_INPUT":
      return "user";
    case "PLANNER_RESPONSE":
      return "assistant";
    default:
      return null;
  }
}

const adapter = new AntigravityCliSessionAdapter();
registry.register(adapter);

export default adapter;
