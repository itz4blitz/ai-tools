import type { PaneState } from "../types.js";

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
  "antigravity-cli": { name: "Antigravity CLI", command: "agy", args: [] },
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
  // Check if there's already a pane for this tool
  const existingIndex = panes.findIndex((p) => p.toolId === toolId);

  if (existingIndex >= 0) {
    return {
      action: "focus",
      paneIndex: existingIndex,
      toolId,
    };
  }

  // Tool needs to be spawned
  const def = TOOL_DEFINITIONS[toolId];
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
