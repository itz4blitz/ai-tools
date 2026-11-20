import type { ToolInfo } from "../types.js";

/**
 * Static tool definitions with their CLI commands.
 */
const TOOL_DEFINITIONS: Record<string, { name: string; command: string }> = {
  claude: { name: "Claude Code", command: "claude" },
  codex: { name: "Codex", command: "codex" },
  gemini: { name: "Gemini CLI", command: "gemini" },
  opencode: { name: "OpenCode", command: "opencode" },
  cursor: { name: "Cursor", command: "cursor" },
  copilot: { name: "GitHub Copilot", command: "gh copilot" },
  droid: { name: "Factory Droid", command: "droid" },
  "antigravity-cli": { name: "Antigravity CLI", command: "agy" },
};

/**
 * Get available tools by merging static definitions with detected tools.
 * Detected tools override static definitions.
 */
export function getAvailableTools(detectedTools?: ToolInfo[]): ToolInfo[] {
  const detected = detectedTools ?? [];
  const detectedIds = new Set(detected.map((t) => t.id));
  const tools: ToolInfo[] = [...detected];

  for (const [id, def] of Object.entries(TOOL_DEFINITIONS)) {
    if (!detectedIds.has(id)) {
      tools.push({
        id,
        name: def.name,
        command: def.command,
        status: "not-installed",
        sessionCount: 0,
      });
    }
  }

  return tools;
}

/**
 * Get the CLI command for a specific tool.
 */
export function getToolCommand(toolId: string): string | null {
  const def = TOOL_DEFINITIONS[toolId];
  return def?.command ?? null;
}

/**
 * Format a list of tools for text display.
 * Returns one line per tool with status indicator.
 */
export function formatToolList(tools: ToolInfo[]): string[] {
  return tools.map((tool) => {
    const icon = statusIcon(tool.status);
    const sessions = tool.sessionCount > 0 ? ` (${tool.sessionCount} sessions)` : "";
    return `${icon} ${tool.name.padEnd(20)} ${tool.command}${sessions}`;
  });
}

function statusIcon(status: ToolInfo["status"]): string {
  switch (status) {
    case "available":
      return "\u2713";
    case "running":
      return "\u25B6";
    case "stopped":
      return "\u25A0";
    case "not-installed":
      return "\u2717";
  }
}
