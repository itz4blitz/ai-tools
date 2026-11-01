import type { SkillDefinition, SkillLayer, GeneratedFile } from "../types/index.js";
import { existsSync } from "node:fs";
import { writeFile, mkdir, copyFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export abstract class BaseSkillAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly nativeSupport: boolean;
  abstract readonly configDir: string;

  /** Home-relative skills directory for the user layer. Defaults to `configDir`. */
  readonly userConfigDir?: string;

  /** Whether this adapter can use symlinks ("symlink") or needs file transformation ("transform"). */
  readonly installStrategy: "symlink" | "transform" = "symlink";

  /** CLI binary name for detection (e.g., "claude", "cursor"). Override in subclass. */
  readonly command?: string;

  abstract generate(skills: SkillDefinition[], layer?: SkillLayer): Promise<GeneratedFile[]>;
  abstract import(cwd?: string): Promise<SkillDefinition[]>;

  /** Skills directory for a layer, relative to the project root or the home directory. */
  skillsDir(layer: SkillLayer = "project"): string {
    return layer === "user" ? (this.userConfigDir ?? this.configDir) : this.configDir;
  }

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

  /**
   * Agent Skills layout: `<dir>/<id>/SKILL.md`. Skills with a `sourceDir` are copied
   * verbatim (SKILL.md plus scripts, references, and prompts).
   */
  protected async skillFolders(
    skills: SkillDefinition[],
    dir: string,
    format: (skill: SkillDefinition) => string,
  ): Promise<GeneratedFile[]> {
    const files: GeneratedFile[] = [];
    for (const skill of skills) {
      if (!skill.sourceDir) {
        files.push({ path: `${dir}/${skill.id}/SKILL.md`, content: format(skill), format: "md" });
        continue;
      }
      const entries = await readdir(skill.sourceDir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const sourcePath = join(entry.parentPath, entry.name);
        const rel = relative(skill.sourceDir, sourcePath).split(sep).join("/");
        files.push({ path: `${dir}/${skill.id}/${rel}`, content: "", format: "md", sourcePath });
      }
    }
    return files;
  }

  async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const file of files) {
      const fullPath = resolve(dir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      if (file.sourcePath) {
        await copyFile(file.sourcePath, fullPath);
      } else {
        await writeFile(fullPath, file.content, "utf-8");
      }
    }
  }

  async uninstall(cwd?: string): Promise<void> {
    // Subclass can override
    void cwd;
  }
}
