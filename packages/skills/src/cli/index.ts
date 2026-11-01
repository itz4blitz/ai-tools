import { registry } from "../adapters/registry.js";
import type { BaseSkillAdapter } from "../adapters/base.js";
import type { SkillLayer, SkillsConfig } from "../types/index.js";
import { homedir } from "node:os";

// Import all adapters to register them
import "../adapters/all.js";

const HELP = `
ai-skills - Universal skills/prompts configuration for AI coding tools

USAGE:
  ai-skills <command> [options]

COMMANDS:
  init        Create an ai-skills.config.ts in the current directory
  detect      Detect which AI tools are installed
  generate    Generate skill files for detected/specified tools
  install     Generate and install skills into detected tools
  import      Import skills from a detected tool
  sync        Sync skills across all detected tools
  export      Export skills to stdout as JSON
  help        Show this help message

OPTIONS:
  --tools     Comma-separated list of tools (e.g., --tools=claude-code,cursor)
  --config    Path to config file (default: ai-skills.config.ts)
  --verbose   Show detailed output
  --dry-run   Show what would be generated without writing files
  --force     Skip detection checks for --tools (install even if tool not found)
  --layer     project (default, under cwd) or user (under the home directory)

EXAMPLES:
  ai-skills init                    # Create config file
  ai-skills detect                  # See which AI tools are installed
  ai-skills generate                # Generate skills for all detected tools
  ai-skills install --tools=cursor  # Install skills for Cursor only
  ai-skills import --tools=claude-code  # Import skills from Claude Code
`;

type Flags = {
  tools?: string;
  config?: string;
  verbose?: boolean;
  dryRun?: boolean;
  force?: boolean;
  layer?: SkillLayer;
};

export async function run(args: string[]): Promise<void> {
  const command = args[0];
  const flags = parseFlags(args.slice(1));

  switch (command) {
    case "init":
      await cmdInit(flags);
      break;
    case "detect":
      await cmdDetect(flags);
      break;
    case "generate":
      await cmdGenerate(flags);
      break;
    case "install":
      await cmdInstall(flags);
      break;
    case "import":
      await cmdImport(flags);
      break;
    case "sync":
      await cmdSync(flags);
      break;
    case "export":
      await cmdExport(flags);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

// ── Commands ────────────────────────────────────────────────

async function cmdInit(flags: Flags): Promise<void> {
  const { existsSync } = await import("node:fs");
  if (existsSync("ai-skills.config.ts")) {
    console.log("Config already exists: ai-skills.config.ts");
    return;
  }

  const { writeFile } = await import("node:fs/promises");

  const template = `import { defineConfig } from "@itz4blitz/ai-tools-skills";

export default defineConfig({
  skills: [
    // Add your skills here:
    //
    // {
    //   id: "review",
    //   name: "Code Review",
    //   description: "Review code for best practices",
    //   content: "Please review the selected code for security, performance, and best practices.",
    // },
  ],
});
`;

  if (flags.dryRun) {
    console.log("[dry-run] Would create ai-skills.config.ts");
    return;
  }

  await writeFile("ai-skills.config.ts", template, "utf-8");
  console.log("Created ai-skills.config.ts");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit ai-skills.config.ts to add your skills");
  console.log("  2. Run: ai-skills detect    (see which AI tools are installed)");
  console.log("  3. Run: ai-skills install   (install skills into your tools)");
}

async function cmdDetect(_flags: Flags): Promise<void> {
  console.log("Detecting AI coding tools...\n");

  const detected = await registry.detectAll();
  const all = registry.list();

  for (const id of all) {
    const adapter = registry.get(id);
    if (!adapter) continue;

    const isDetected = detected.some((d) => d.id === id);
    const icon = isDetected ? "\u2713" : "\u2717";
    const color = isDetected ? "\x1b[32m" : "\x1b[90m";
    const reset = "\x1b[0m";

    console.log(`  ${color}${icon}${reset} ${adapter.name.padEnd(20)} ${adapter.id}`);
  }

  console.log(`\nDetected ${detected.length}/${all.length} tools`);
}

async function cmdGenerate(flags: Flags): Promise<void> {
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No AI tools detected. Use --tools to specify manually.");
    return;
  }

  const config = await loadConfig(flags.config);

  console.log(`Generating skills for ${adapters.length} tool(s)...\n`);

  for (const adapter of adapters) {
    const files = await adapter.generate(config.skills, flags.layer);

    for (const file of files) {
      if (flags.dryRun) {
        console.log(`  [dry-run] Would write: ${file.path}`);
      } else {
        console.log(`  Generated: ${file.path}`);
      }
    }

    if (!flags.dryRun) {
      await adapter.install(files, layerRoot(flags));
    }
  }

  console.log("\nDone!");
}

async function cmdInstall(flags: Flags): Promise<void> {
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No AI tools detected. Use --tools to specify manually.");
    return;
  }

  const config = await loadConfig(flags.config);

  console.log(`Installing skills into ${adapters.length} tool(s)...\n`);

  for (const adapter of adapters) {
    const files = await adapter.generate(config.skills, flags.layer);

    if (flags.dryRun) {
      for (const file of files) {
        console.log(`  [dry-run] Would install: ${file.path}`);
      }
    } else {
      await adapter.install(files, layerRoot(flags));
      console.log(`  \u2713 ${adapter.name}`);
    }
  }

  console.log("\nSkills installed!");
}

async function cmdImport(flags: Flags): Promise<void> {
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No AI tools detected. Use --tools to specify manually.");
    return;
  }

  for (const adapter of adapters) {
    const skills = await adapter.import();
    console.log(`\nImported ${skills.length} skill(s) from ${adapter.name}:`);
    for (const skill of skills) {
      console.log(`  - ${skill.name} (${skill.id})`);
    }
  }
}

async function cmdSync(flags: Flags): Promise<void> {
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No AI tools detected. Use --tools to specify manually.");
    return;
  }

  const config = await loadConfig(flags.config);

  console.log(`Syncing skills to ${adapters.length} tool(s)...\n`);

  for (const adapter of adapters) {
    const files = await adapter.generate(config.skills, flags.layer);

    if (flags.dryRun) {
      for (const file of files) {
        console.log(`  [dry-run] Would sync: ${file.path}`);
      }
    } else {
      await adapter.install(files, layerRoot(flags));
      console.log(`  \u2713 ${adapter.name}`);
    }
  }

  console.log("\nSkills synced!");
}

async function cmdExport(flags: Flags): Promise<void> {
  const config = await loadConfig(flags.config);
  console.log(JSON.stringify(config.skills, null, 2));
}

// ── Helpers ─────────────────────────────────────────────────

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};

  for (const arg of args) {
    if (arg.startsWith("--tools=")) {
      flags.tools = arg.slice(8);
    } else if (arg.startsWith("--config=")) {
      flags.config = arg.slice(9);
    } else if (arg === "--verbose") {
      flags.verbose = true;
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--force") {
      flags.force = true;
    } else if (arg.startsWith("--layer=")) {
      const layer = arg.slice(8);
      if (layer !== "user" && layer !== "project") {
        throw new Error(`Invalid --layer "${layer}" (expected user or project)`);
      }
      flags.layer = layer;
    }
  }

  return flags;
}

/** Root that skill paths resolve against: the home directory for the user layer, else cwd. */
function layerRoot(flags: Flags): string | undefined {
  return flags.layer === "user" ? homedir() : undefined;
}

async function resolveAdapters(flags: Flags): Promise<BaseSkillAdapter[]> {
  if (flags.tools) {
    const ids = flags.tools.split(",").map((t) => t.trim());
    const adapters: BaseSkillAdapter[] = [];
    for (const id of ids) {
      const adapter = registry.get(id);
      if (!adapter) {
        console.warn(`  Warning: Unknown adapter "${id}"`);
        continue;
      }
      if (!flags.force && !(await adapter.detect(layerRoot(flags)))) {
        console.warn(`  Warning: ${adapter.name} not detected, skipping (use --force to override)`);
        continue;
      }
      adapters.push(adapter);
    }
    return adapters;
  }

  return registry.detectAll(layerRoot(flags));
}

async function loadConfig(configPath?: string): Promise<SkillsConfig> {
  const path = configPath ?? "ai-skills.config.ts";
  const { existsSync } = await import("node:fs");

  if (!existsSync(path)) {
    if (configPath) {
      throw new Error(`Config file not found: ${path}`);
    }
    return { skills: [] };
  }

  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const fullPath = resolve(process.cwd(), path);
  const mod = await import(pathToFileURL(fullPath).href);
  return mod.default as SkillsConfig;
}
