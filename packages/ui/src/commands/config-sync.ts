import { execFile } from "node:child_process";

export type CanonicalStatus = {
  exists: boolean;
  path: string;
  engineCount: number;
};

/**
 * Trigger the canonical generate command.
 * Returns a promise that resolves with stdout or rejects with stderr.
 */
export async function triggerGenerate(): Promise<string> {
  return execCommand("npx", ["ai-tools", "generate"]);
}

/**
 * Trigger the canonical install command.
 * Returns a promise that resolves with stdout or rejects with stderr.
 */
export async function triggerInstall(): Promise<string> {
  return execCommand("npx", ["ai-tools", "install"]);
}

/**
 * Trigger config-scoped MCP sync for detected tools.
 * Refuses when mcp.config.ts selects no servers (never copies imports).
 */
export async function triggerSync(): Promise<string> {
  return execCommand("npx", ["ai-tools", "mcp", "sync"]);
}

/**
 * Trigger the canonical detect command.
 * Returns a promise that resolves with stdout or rejects with stderr.
 */
export async function triggerDetect(): Promise<string> {
  return execCommand("npx", ["ai-tools", "detect"]);
}

const NON_ENGINE_FILES = new Set(["config.json", "manifest.json"]);

/**
 * Check the .ai-tools/ directory status.
 */
export async function getCanonicalStatus(): Promise<CanonicalStatus> {
  const { existsSync, readdirSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const configDir = resolve(process.cwd(), ".ai-tools");
  const exists = existsSync(configDir);

  let engineCount = 0;
  if (exists) {
    try {
      const entries = readdirSync(configDir);
      engineCount = entries.filter(
        (e) =>
          !NON_ENGINE_FILES.has(e) &&
          (e.endsWith(".json") || e.endsWith(".ts") || e.endsWith(".js")),
      ).length;
    } catch {
      // Directory read failed
    }
  }

  return {
    exists,
    path: configDir,
    engineCount,
  };
}

function execCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: process.cwd(), shell: process.platform === "win32" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
