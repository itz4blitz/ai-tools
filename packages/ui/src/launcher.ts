import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { switchTool } from "./commands/switch-tool.js";
import type { PaneState } from "./types.js";

export type LaunchOptions = {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type LaunchResult = {
  pid: number;
  exitCode: number;
};

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

const UNSAFE_WIN32_SHELL_ARG = /[\r\n&|<>^%"]/;

/**
 * Launch a tool in full-screen mode (inherits stdio).
 * Returns a promise that resolves when the process exits.
 * Accepts a spawn function for dependency injection in tests.
 */
export function launchTool(
  options: LaunchOptions,
  spawnFn: SpawnFn = spawn,
): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    const useShell =
      process.platform === "win32" && !options.args.some((arg) => UNSAFE_WIN32_SHELL_ARG.test(arg));
    const child = spawnFn(options.command, options.args, {
      stdio: "inherit",
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      shell: useShell,
    });

    const pid = child.pid ?? 0;

    child.on("close", (code) => {
      resolve({ pid, exitCode: code ?? 1 });
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Build launch options from a tool ID using switchTool().
 * Returns null if tool is unknown or already focused.
 */
export function buildLaunchOptions(toolId: string, panes: PaneState[]): LaunchOptions | null {
  const result = switchTool(toolId, panes);
  if (!result || result.action !== "spawn" || !result.command) return null;

  return {
    command: result.command,
    args: result.args ?? [],
  };
}

/**
 * Build launch options for a handoff command.
 */
export function buildHandoffLaunchOptions(
  launchCommand: string,
  launchArgs: string[],
): LaunchOptions {
  return {
    command: launchCommand,
    args: launchArgs,
  };
}
