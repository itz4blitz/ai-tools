import { HANDOFF_TARGETS, type SessionContext } from "@itz4blitz/ai-tools-sessions";
import { loadSessionRegistry } from "./handoff-runtime.js";

/**
 * Extract handoff context from a session using the adapter registry.
 */
export async function extractHandoffContext(sessionId: string): Promise<SessionContext | null> {
  const { registry } = await loadSessionRegistry();

  const detected = await registry.detectAll();

  for (const adapter of detected) {
    try {
      const sessions = await adapter.parseSessions();
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        return adapter.extractContext(session);
      }
    } catch {
      // Skip failing adapters
    }
  }

  return null;
}

/**
 * Format handoff context as a markdown preview.
 */
export function previewHandoff(context: SessionContext): string {
  const lines = [
    `# Handoff Preview`,
    "",
    `**From:** ${context.tool}`,
    `**Session:** ${context.sessionId}`,
    `**Title:** ${context.title}`,
    "",
    "## Summary",
    "",
    context.summary,
    "",
  ];

  if (context.keyFiles.length > 0) {
    lines.push("## Key Files", "");
    for (const file of context.keyFiles) {
      lines.push(`- ${file}`);
    }
    lines.push("");
  }

  if (context.keyDecisions.length > 0) {
    lines.push("## Key Decisions", "");
    for (const decision of context.keyDecisions) {
      lines.push(`- ${decision}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Get list of tools that support handoff launching.
 */
export function getTargetTools(): Array<{ id: string; name: string; command: string }> {
  return HANDOFF_TARGETS.map((target) => ({
    id: target.id,
    name: target.name,
    command: target.command,
  }));
}
