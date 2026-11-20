import type {
  UnifiedSession,
  SessionContext,
  SessionFilter,
  SessionMessage,
} from "../types/index.js";

export abstract class BaseSessionAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly command: string;
  abstract readonly storagePaths: string[];

  /**
   * Parse sessions from this tool's storage.
   */
  abstract parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]>;

  /**
   * Extract handoff context from a session.
   */
  async extractContext(session: UnifiedSession): Promise<SessionContext> {
    const keyFiles = this.extractFileReferences(session);
    const keyDecisions = this.extractDecisions(session);
    const summary = this.generateSummary(session);
    const title =
      this.resolveSessionTitle(session.title, session.messages) ?? `${session.toolName} session`;

    const partial: Omit<SessionContext, "handoffMarkdown"> = {
      sessionId: session.id,
      tool: session.tool,
      title,
      summary,
      keyFiles,
      keyDecisions,
      lastActivity: session.updatedAt,
    };

    return {
      ...partial,
      handoffMarkdown: this.formatHandoff({
        ...partial,
        handoffMarkdown: "",
      }),
    };
  }

  /**
   * Detect if this tool is installed.
   */
  async detect(): Promise<boolean> {
    return this.commandExists(this.command);
  }

  /**
   * Get the resolved storage path (first existing path).
   */
  async getStoragePath(): Promise<string | null> {
    const { existsSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    for (const p of this.storagePaths) {
      let resolved = p.replace("~", homedir());
      if (appData) {
        resolved = resolved.replace(/%APPDATA%/gi, () => appData);
      }
      if (localAppData) {
        resolved = resolved.replace(/%LOCALAPPDATA%/gi, () => localAppData);
      }
      if (existsSync(resolved)) return resolved;
    }
    return null;
  }

  // -- Protected helpers --

  protected extractFileReferences(session: UnifiedSession): string[] {
    const files = new Set<string>();
    for (const msg of session.messages) {
      const filePattern = /(?:^|\s)([./][\w/.-]+\.\w+)/g;
      let match;
      while ((match = filePattern.exec(msg.content)) !== null) {
        const file = match[1];
        if (file) files.add(file);
      }
    }
    return [...files];
  }

  protected extractDecisions(session: UnifiedSession): string[] {
    const decisions: string[] = [];
    for (const msg of session.messages) {
      if (msg.role !== "assistant") continue;
      const patterns = [/(?:I'll|I will|Let's|Let me|We should|Going to)\s+(.+?)(?:\.|$)/gi];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(msg.content)) !== null) {
          const decision = match[1];
          if (decision && decision.length > 10 && decision.length < 200) {
            decisions.push(decision.trim());
          }
        }
      }
    }
    return decisions.slice(0, 10);
  }

  protected generateSummary(session: UnifiedSession): string {
    const msgCount = session.messageCount;
    const userMsgs = session.messages.filter((m) => m.role === "user");
    const firstUserMsg = userMsgs[0]?.content ?? "No user messages";
    const truncated = firstUserMsg.length > 200 ? firstUserMsg.slice(0, 200) + "..." : firstUserMsg;
    return `Session with ${msgCount} messages. Started with: "${truncated}"`;
  }

  protected formatHandoff(ctx: SessionContext): string {
    const lines = [
      `# Session Handoff: ${ctx.title}`,
      "",
      `**From:** ${ctx.tool}`,
      `**Session:** ${ctx.sessionId}`,
      `**Last Activity:** ${ctx.lastActivity}`,
      "",
      "## Summary",
      "",
      ctx.summary,
      "",
    ];

    if (ctx.keyFiles.length > 0) {
      lines.push("## Key Files", "");
      for (const file of ctx.keyFiles) {
        lines.push(`- ${file}`);
      }
      lines.push("");
    }

    if (ctx.keyDecisions.length > 0) {
      lines.push("## Key Decisions", "");
      for (const decision of ctx.keyDecisions) {
        lines.push(`- ${decision}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  protected resolveSessionTitle(
    title: string | undefined,
    messages?: SessionMessage[],
  ): string | undefined {
    const explicitTitle = this.normalizeTitle(title);
    if (explicitTitle) return explicitTitle;
    if (!messages) return undefined;

    const rolePriority: Array<SessionMessage["role"]> = ["user", "assistant", "system", "tool"];

    for (const role of rolePriority) {
      for (const message of messages) {
        if (message.role !== role) continue;
        const lines = message.content.split(/\r?\n/);
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line.startsWith("```")) continue;
          const cleaned = line
            .replace(/^#{1,6}\s+/, "")
            .replace(/^[-*+]\s+/, "")
            .replace(/^\d+[.)]\s+/, "");
          const normalized = this.normalizeTitle(cleaned);
          if (normalized) return normalized;
        }
      }
    }

    return undefined;
  }

  private normalizeTitle(input: string | undefined): string | undefined {
    if (!input) return undefined;

    let title = input.trim().replace(/\s+/g, " ");
    title = title.replace(/^[`"']+|[`"']+$/g, "");
    title = title.trim();

    if (!title) return undefined;

    return title.length > 80 ? `${title.slice(0, 77).trimEnd()}...` : title;
  }

  protected async commandExists(command: string): Promise<boolean> {
    const { execFile } = await import("node:child_process");
    const lookupCommand = process.platform === "win32" ? "where" : "which";
    return new Promise((ok) => {
      execFile(lookupCommand, [command], (error) => {
        ok(!error);
      });
    });
  }
}
