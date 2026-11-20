import type { RuleDefinition, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export abstract class BaseRuleAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly nativeSupport: boolean;
  abstract readonly configDir: string;

  /** Whether this adapter can use symlinks ("symlink") or needs file transformation ("transform"). */
  readonly installStrategy: "symlink" | "transform" = "transform";

  /** CLI binary name for detection (e.g., "claude", "cursor"). Override in subclass. */
  readonly command?: string;

  abstract generate(rules: RuleDefinition[]): Promise<GeneratedFile[]>;
  abstract import(cwd?: string): Promise<RuleDefinition[]>;

  async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    const hasDir = existsSync(resolve(dir, this.configDir));
    if (hasDir) return true;
    if (this.command) return this.commandExists(this.command);
    return false;
  }

  protected async commandExists(command: string): Promise<boolean> {
    const { execFile } = await import("node:child_process");
    const lookupCommand = process.platform === "win32" ? "where" : "which";
    return new Promise((ok) => {
      execFile(lookupCommand, [command], (error: Error | null) => {
        ok(!error);
      });
    });
  }

  async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.content, "utf-8");
    }
  }

  async uninstall(cwd?: string): Promise<void> {
    void cwd;
  }
}
