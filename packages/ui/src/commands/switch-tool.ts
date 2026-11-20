import type { PaneState } from "../types.js";

const TOOL_ID_ALIASES: Record<string, string> = {
  "claude-code": "claude",
  "gemini-cli": "gemini",
};

function normalizeToolId(toolId: string): string {
  return TOOL_ID_ALIASES[toolId] ?? toolId;
}

/**
 * Static tool definitions with their CLI commands.
 */
const TOOL_DEFINITIONS: Record<string, { name: string; command: string; args: string[] }> = {
  claude: { name: "Claude Code", command: "claude", args: [] },
  codex: { name: "Codex", command: "codex", args: [] },
  gemini: { name: "Gemini CLI", command: "gemini", args: [] },
  opencode: { name: "OpenCode", command: "opencode", args: [] },
  cursor: { name: "Cursor", command: "cursor", args: [] },
  copilot: { name: "GitHub Copilot", command: "gh", args: ["copilot"] },
  droid: { name: "Factory Droid", command: "droid", args: [] },
};

export type SwitchResult = {
  action: "focus" | "spawn";
  paneIndex: number;
  toolId: string;
  command?: string;
  args?: string[];
};

/**
 * Switch to a tool: focus existing pane or signal that a new one should be spawned.
 */
export function switchTool(toolId: string, panes: PaneState[]): SwitchResult | null {
  const normalizedId = normalizeToolId(toolId);

  // Check if there's already a pane for this tool (matching direct ID or canonical alias)
  const existingIndex = panes.findIndex(
    (p) => p.toolId === toolId || normalizeToolId(p.toolId) === normalizedId,
  );

  if (existingIndex >= 0) {
    return {
      action: "focus",
      paneIndex: existingIndex,
      toolId,
    };
  }

  // Tool needs to be spawned
  const def = TOOL_DEFINITIONS[toolId] ?? TOOL_DEFINITIONS[normalizedId];
  if (!def) return null;

  return {
    action: "spawn",
    paneIndex: panes.length,
    toolId,
    command: def.command,
    args: def.args,
  };
}

/**
 * Get the static map of supported tools with their commands.
 */
export function getToolDefinitions(): Record<
  string,
  { name: string; command: string; args: string[] }
> {
  return { ...TOOL_DEFINITIONS };
}
