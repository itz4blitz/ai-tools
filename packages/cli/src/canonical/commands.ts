import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { writeConfig, isCanonical, getMode } from "./config.js";
import { readManifest, writeManifest } from "./manifest.js";
import { addManagedBlock, removeManagedBlock, hasManagedBlock } from "./gitignore.js";
import type { AiToolsConfig, ManifestEntry, ManifestTarget } from "./types.js";

type EngineModule = {
  name: string;
  pkg: string;
  configPkg: string;
  configFiles: string[];
};

const ENGINES: EngineModule[] = [
  {
    name: "hooks",
    pkg: "@itz4blitz/ai-tools-hooks/cli",
    configPkg: "@itz4blitz/ai-tools-hooks",
    configFiles: ["ai-hooks.config.ts", "ai-tools-hooks.config.ts"],
  },
  {
    name: "mcp",
    pkg: "@itz4blitz/ai-tools-mcp/cli",
    configPkg: "@itz4blitz/ai-tools-mcp",
    configFiles: ["mcp.config.ts"],
  },
  {
    name: "skills",
    pkg: "@itz4blitz/ai-tools-skills/cli",
    configPkg: "@itz4blitz/ai-tools-skills",
    configFiles: ["ai-skills.config.ts"],
  },
  {
    name: "agents",
    pkg: "@itz4blitz/ai-tools-agents/cli",
    configPkg: "@itz4blitz/ai-tools-agents",
    configFiles: ["ai-agents.config.ts"],
  },
  {
    name: "rules",
    pkg: "@itz4blitz/ai-tools-rules/cli",
    configPkg: "@itz4blitz/ai-tools-rules",
    configFiles: ["ai-rules.config.ts"],
  },
];

const TOOL_TARGETS: Array<{ dir: string; adapterId: string }> = [
  { dir: ".claude", adapterId: "claude-code" },
  { dir: ".cursor", adapterId: "cursor" },
  { dir: ".opencode", adapterId: "opencode" },
  { dir: ".gemini", adapterId: "gemini-cli" },
  { dir: ".cline", adapterId: "cline" },
  { dir: ".factory", adapterId: "droid" },
  { dir: ".codex", adapterId: "codex" },
  { dir: ".kiro", adapterId: "kiro" },
  { dir: ".amp", adapterId: "amp" },
  { dir: ".grok", adapterId: "grok" },
  { dir: ".zcode", adapterId: "zcode" },
  { dir: ".continue", adapterId: "continue" },
  { dir: ".roo", adapterId: "roo-code" },
  { dir: ".agents", adapterId: "antigravity-cli" },
  { dir: ".windsurf", adapterId: "windsurf" },
];

const TOOL_DIRS = TOOL_TARGETS.map((target) => target.dir);

type FileSnapshotEntry = {
  adapterId: string;
  mtimeMs: number;
  size: number;
};

type ToolSnapshot = {
  dirs: Set<string>;
  files: Map<string, FileSnapshotEntry>;
};

async function snapshotToolFiles(cwd: string): Promise<ToolSnapshot> {
  const dirs = new Set<string>();
  const files = new Map<string, FileSnapshotEntry>();

  for (const target of TOOL_TARGETS) {
    const fullDir = resolve(cwd, target.dir);
    if (!existsSync(fullDir)) continue;
    dirs.add(target.dir);

    try {
      const entries = await readdir(fullDir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fullPath = resolve(entry.parentPath, entry.name);
        const relPath = relative(cwd, fullPath).split(sep).join("/");
        try {
          const info = await stat(fullPath);
          files.set(relPath, {
            adapterId: target.adapterId,
            mtimeMs: info.mtimeMs,
            size: info.size,
          });
        } catch {
          // Ignore transient files that disappeared during traversal
        }
      }
    } catch {
      // Ignore unreadable or non-directory targets
    }
  }

  return { dirs, files };
}

function diffInstalledTargets(
  before: ToolSnapshot,
  after: ToolSnapshot,
  existingTargets: ManifestTarget[],
  cwd: string,
): ManifestTarget[] {
  const recorded = new Map<string, ManifestTarget>();

  for (const target of existingTargets) {
    if (existsSync(resolve(cwd, target.targetPath))) {
      recorded.set(target.targetPath, target);
    }
  }

  for (const [relPath, afterInfo] of after.files) {
    const beforeInfo = before.files.get(relPath);
    if (
      !beforeInfo ||
      beforeInfo.mtimeMs !== afterInfo.mtimeMs ||
      beforeInfo.size !== afterInfo.size
    ) {
      recorded.set(relPath, {
        adapterId: afterInfo.adapterId,
        targetPath: relPath,
        strategy: "transform",
        status: "direct",
      });
    }
  }

  for (const target of TOOL_TARGETS) {
    if (!before.dirs.has(target.dir) && after.dirs.has(target.dir)) {
      const hasFileInDir = [...recorded.keys()].some(
        (key) => key === target.dir || key.startsWith(`${target.dir}/`),
      );
      if (!hasFileInDir) {
        recorded.set(target.dir, {
          adapterId: target.adapterId,
          targetPath: target.dir,
          strategy: "transform",
          status: "direct",
        });
      }
    }
  }

  return [...recorded.values()];
}

function resolveCanonicalPath(cwd: string, engine: EngineModule): string {
  const canonicalDir = `.ai-tools/${engine.name}`;
  if (existsSync(resolve(cwd, canonicalDir))) {
    return `${canonicalDir}/`;
  }
  for (const configFile of engine.configFiles) {
    if (existsSync(resolve(cwd, configFile))) {
      return configFile;
    }
  }
  return "";
}

function isWithinCwd(cwd: string, fullPath: string): boolean {
  const rel = relative(cwd, fullPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function hasFlag(flags: string[], flag: string): boolean {
  return flags.includes(flag);
}

// ── init ────────────────────────────────────────────────────

export async function cmdInit(flags: string[]): Promise<void> {
  const dryRun = hasFlag(flags, "--dry-run");

  const existing = await getMode();
  if (existing === "canonical") {
    console.log("Already initialized in canonical mode.");
    return;
  }

  const config: AiToolsConfig = {
    mode: "canonical",
    createdAt: new Date().toISOString(),
  };

  if (dryRun) {
    console.log("[dry-run] Would create .ai-tools/config.json");
    console.log("[dry-run] Would add managed block to .gitignore");
    return;
  }

  await writeConfig(config);
  await addManagedBlock();

  console.log("Initialized .ai-tools/ in canonical mode.");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Run: ai-tools generate   (write engine files from configs)");
  console.log("  2. Run: ai-tools install    (install to tool directories)");
  console.log("  3. Run: ai-tools status     (check installation health)");
}

// ── generate ────────────────────────────────────────────────

export async function cmdGenerate(flags: string[]): Promise<void> {
  const dryRun = hasFlag(flags, "--dry-run");

  const canonical = await isCanonical();
  if (!canonical) {
    console.error("Not in canonical mode. Run 'ai-tools init' first.");
    process.exit(1);
    return;
  }

  console.log("Generating engine files from configs...\n");

  for (const engine of ENGINES) {
    try {
      const mod = (await import(engine.pkg)) as { run: (args: string[]) => Promise<void> };
      const generateArgs = ["generate", ...flags];
      if (dryRun) {
        console.log(`  [dry-run] ${engine.name}: would generate`);
      } else {
        console.log(`  ${engine.name}: generating...`);
        await mod.run(generateArgs);
      }
    } catch (err) {
      console.error(`  ${engine.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\nDone!");
}

// ── install ─────────────────────────────────────────────────

export async function cmdInstall(flags: string[]): Promise<void> {
  const dryRun = hasFlag(flags, "--dry-run");

  const canonical = await isCanonical();
  if (!canonical) {
    console.error("Not in canonical mode. Run 'ai-tools init' first.");
    process.exit(1);
    return;
  }

  console.log("Installing engine configs into tool directories...\n");

  const manifest = await readManifest();
  let totalInstalled = 0;
  const cwd = process.cwd();

  for (const engine of ENGINES) {
    try {
      const mod = (await import(engine.pkg)) as { run: (args: string[]) => Promise<void> };
      const installArgs = ["install", ...flags];
      if (dryRun) {
        console.log(`  [dry-run] ${engine.name}: would install`);
      } else {
        console.log(`  ${engine.name}: installing...`);
        const before = await snapshotToolFiles(cwd);
        await mod.run(installArgs);
        const after = await snapshotToolFiles(cwd);
        totalInstalled++;

        const idx = manifest.entries.findIndex(
          (e) => e.engine === engine.name && e.id === engine.name,
        );
        const existingTargets = idx >= 0 ? (manifest.entries[idx]?.targets ?? []) : [];
        const targets = diffInstalledTargets(before, after, existingTargets, cwd);

        if (targets.length > 0) {
          const entry: ManifestEntry = {
            engine: engine.name,
            id: engine.name,
            canonicalPath: resolveCanonicalPath(cwd, engine),
            targets,
            updatedAt: new Date().toISOString(),
          };
          if (idx >= 0) {
            manifest.entries[idx] = entry;
          } else {
            manifest.entries.push(entry);
          }
        } else if (idx >= 0) {
          manifest.entries.splice(idx, 1);
        }
      }
    } catch (err) {
      console.error(`  ${engine.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!dryRun) {
    await writeManifest(manifest);
  }

  console.log(`\nInstalled ${totalInstalled} engine(s).`);
}

// ── status ──────────────────────────────────────────────────

export async function cmdStatus(flags: string[]): Promise<void> {
  void flags;

  const mode = await getMode();
  const hasGitignore = await hasManagedBlock();
  const manifest = await readManifest();

  console.log(`Mode: ${mode}`);
  console.log(`Gitignore managed: ${hasGitignore ? "yes" : "no"}`);
  console.log(`Manifest entries: ${manifest.entries.length}`);

  if (manifest.entries.length > 0) {
    console.log("\nEntries:");
    for (const entry of manifest.entries) {
      const targetInfo = entry.targets
        .map((t: ManifestTarget) => `${t.adapterId}(${t.status})`)
        .join(", ");
      console.log(`  ${entry.engine}/${entry.id}: ${targetInfo || "no targets"}`);
    }
  }

  // Check for tool directories
  const cwd = process.cwd();

  console.log("\nTool directories:");
  for (const dir of TOOL_DIRS) {
    const exists = existsSync(resolve(cwd, dir));
    const icon = exists ? "+" : "-";
    console.log(`  ${icon} ${dir}`);
  }
}

// ── clean ───────────────────────────────────────────────────

export async function cmdClean(flags: string[]): Promise<void> {
  const dryRun = hasFlag(flags, "--dry-run");
  const force = hasFlag(flags, "--force");

  const canonical = await isCanonical();
  if (!canonical && !force) {
    console.error(
      "Not in canonical mode. Refusing to clean unmanaged tool directories. Run 'ai-tools init' first or pass --force.",
    );
    process.exit(1);
    return;
  }

  const cwd = process.cwd();
  const manifest = await readManifest();
  const trackedPaths = [
    ...new Set(manifest.entries.flatMap((entry) => entry.targets.map((t) => t.targetPath))),
  ];

  console.log("Cleaning manifest-tracked targets...\n");

  let cleaned = 0;
  for (const targetPath of trackedPaths) {
    const fullPath = resolve(cwd, targetPath);
    if (!isWithinCwd(cwd, fullPath)) continue;
    if (existsSync(fullPath)) {
      if (dryRun) {
        console.log(`  [dry-run] Would remove: ${targetPath}`);
      } else {
        await rm(fullPath, { recursive: true, force: true });
        console.log(`  Removed: ${targetPath}`);
      }
      cleaned++;
    }
  }

  if (!dryRun) {
    if (manifest.entries.length > 0) {
      await writeManifest({ version: 1, entries: [] });
    }
    await removeManagedBlock();
  }

  if (cleaned === 0) {
    console.log("  No manifest-tracked targets found.");
  } else {
    console.log(`\nCleaned ${cleaned} target${cleaned === 1 ? "" : "s"}.`);
  }
}
