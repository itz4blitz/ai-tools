import { spawn } from "node:child_process";
import type { SessionContext } from "../types/index.js";
import { formatHandoffMarkdown } from "./markdown.js";

export type HandoffTargetConfig = {
  id: string;
  aliases?: readonly string[];
  name: string;
  command: string;
  /** How the handoff prompt is passed: positional arg, or flag + arg. */
  promptMode: "positional" | "flag";
  promptFlag?: string;
};

/**
 * Single source of truth for tools that support handoff launching.
 */
export const HANDOFF_TARGETS: readonly HandoffTargetConfig[] = [
  {
    id: "claude",
    aliases: ["claude-code"],
    name: "Claude Code",
    command: "claude",
    promptMode: "positional",
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    promptMode: "positional",
  },
  {
    id: "gemini",
    aliases: ["gemini-cli"],
    name: "Gemini CLI",
    command: "gemini",
    promptMode: "flag",
    promptFlag: "-i",
  },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    promptMode: "flag",
    promptFlag: "--prompt",
  },
];

/**
 * Resolve a handoff target by primary ID or canonical alias (e.g. "claude-code" -> "claude").
 */
export function resolveHandoffTarget(toolId: string): HandoffTargetConfig | undefined {
  return HANDOFF_TARGETS.find(
    (target) => target.id === toolId || (target.aliases?.includes(toolId) ?? false),
  );
}

/**
 * Build the CLI command and args to launch a target tool with a handoff prompt.
 */
export function buildHandoffCommand(
  toolId: string,
  handoffMarkdown: string,
): { command: string; args: string[] } | null {
  const target = resolveHandoffTarget(toolId);
  if (!target) return null;

  const args =
    target.promptMode === "flag" && target.promptFlag
      ? [target.promptFlag, handoffMarkdown]
      : [handoffMarkdown];

  return { command: target.command, args };
}

/**
 * Launch a tool with handoff context.
 */
export function launchWithContext(
  tool: string,
  context: SessionContext,
): { command: string; args: string[] } | null {
  const target = resolveHandoffTarget(tool);
  if (!target) return null;

  const markdown = formatHandoffMarkdown(context);
  return buildHandoffCommand(target.id, markdown);
}

const UNSAFE_WIN32_SHELL_ARG = /[\r\n&|<>^%"]/;

/**
 * Spawn a tool process with handoff context.
 * Only uses shell: true on Windows when arguments are free of cmd.exe metacharacters
 * and newlines, avoiding prompt truncation and command injection.
 */
export function spawnTool(
  command: string,
  args: string[],
  options?: { cwd?: string },
): ReturnType<typeof spawn> {
  const useShell =
    process.platform === "win32" && !args.some((arg) => UNSAFE_WIN32_SHELL_ARG.test(arg));
  return spawn(command, args, {
    stdio: "inherit",
    cwd: options?.cwd,
    shell: useShell,
  });
}
