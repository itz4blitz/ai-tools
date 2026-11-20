import type { AppState, ToolInfo } from "./types.js";

/**
 * Create an empty initial application state.
 */
export function createInitialState(): AppState {
  return {
    mode: "unknown",
    tools: [],
    panes: [],
    activePaneIndex: 0,
    sessionCount: 0,
    configHealth: "healthy",
  };
}

/**
 * Detect installed tools in parallel.
 * Each tool is detected concurrently; session counts are fetched in parallel too.
 */
export async function detectTools(): Promise<ToolInfo[]> {
  const { registry } = await import("@itz4blitz/ai-tools-sessions");
  await import("@itz4blitz/ai-tools-sessions/adapters/all");

  const adapterIds = registry.list();

  const results = await Promise.all(
    adapterIds.map(async (id): Promise<ToolInfo> => {
      const adapter = registry.get(id);
      if (!adapter) {
        return { id, name: id, command: id, status: "not-installed", sessionCount: 0 };
      }

      let detected = false;
      try {
        detected = await adapter.detect();
      } catch {
        // Detection failed — treat as not installed
      }

      let sessionCount = 0;
      if (detected) {
        try {
          const sessions = await adapter.parseSessions();
          sessionCount = sessions.length;
        } catch {
          // Session parse failed — 0 sessions
        }
      }

      return {
        id: adapter.id,
        name: adapter.name,
        command: adapter.command,
        status: detected ? "available" : "not-installed",
        sessionCount,
      };
    }),
  );

  return results;
}

/**
 * Detect which mode the project is running in.
 *
 * - "canonical": .ai-tools/ config directory exists in cwd
 * - "direct":    no config dir, but tools are detected
 * - "unknown":   can't determine
 */
export async function detectMode(): Promise<"canonical" | "direct" | "unknown"> {
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const configDir = resolve(process.cwd(), ".ai-tools");
  if (existsSync(configDir)) return "canonical";

  // Check if any tool config file exists in common locations
  const directMarkers = [
    "CLAUDE.md",
    ".claude",
    ".gemini",
    "codex.md",
    ".cursor",
    ".opencode",
    ".codex",
    ".factory",
    ".kiro",
    ".cline",
    ".clinerules",
    ".grok",
    ".zcode",
    ".roo",
    ".roomodes",
    ".windsurf",
    ".continue",
    ".amp",
    ".agents",
    "AGENTS.md",
    "GEMINI.md",
    ".mcp.json",
    "opencode.json",
  ].map((marker) => resolve(process.cwd(), marker));
  if (directMarkers.some((p) => existsSync(p))) return "direct";

  return "unknown";
}

/**
 * Check whether canonical config (.ai-tools/) exists and is valid,
 * or whether the repository is a valid direct-mode workspace.
 */
export async function computeConfigHealth(): Promise<"healthy" | "stale" | "error"> {
  const { existsSync, statSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const configDir = resolve(process.cwd(), ".ai-tools");

  if (!existsSync(configDir)) {
    const mode = await detectMode();
    return mode === "direct" ? "healthy" : "error";
  }

  try {
    const stat = statSync(configDir);
    const age = Date.now() - stat.mtimeMs;
    const oneDay = 24 * 60 * 60 * 1000;

    if (age > oneDay) {
      return "stale";
    }

    return "healthy";
  } catch {
    return "error";
  }
}

/**
 * Compute status bar data from current application state.
 */
export function getStatusBarData(state: AppState): {
  mode: string;
  activeTool: string;
  sessionCount: number;
  configHealth: string;
} {
  const activePane = state.panes[state.activePaneIndex];
  const activeTool = activePane
    ? (state.tools.find((t) => t.id === activePane.toolId)?.name ?? "None")
    : "None";

  return {
    mode: state.mode,
    activeTool,
    sessionCount: state.sessionCount,
    configHealth: state.configHealth,
  };
}
