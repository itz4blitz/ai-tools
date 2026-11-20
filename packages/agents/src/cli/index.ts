import { registry } from "../adapters/registry.js";
import type { BaseAgentAdapter } from "../adapters/base.js";
import type { AgentsConfig } from "../types/index.js";

// Import all adapters to register them
import "../adapters/all.js";

const HELP = `
ai-agents - Universal agent configuration for AI coding tools

USAGE:
  ai-agents <command> [options]

COMMANDS:
  init        Create an ai-agents.config.ts in the current directory
  detect      Detect which AI tools are installed
  generate    Generate agent configs for detected/specified tools
  install     Generate and install agents into detected tools
  import      Import existing agents from detected tools
  sync        Sync agents across all detected tools
  export      Export agents as JSON to stdout
  help        Show this help message

OPTIONS:
  --tools     Comma-separated list of tools (e.g., --tools=claude-code,cursor)
  --config    Path to agents config file
  --verbose   Show detailed output
  --dry-run   Show what would be generated without writing files
  --force     Skip detection checks for --tools (install even if tool not found)

EXAMPLES:
  ai-agents init                            # Create config file
  ai-agents detect                          # See which AI tools support agents
  ai-agents generate                        # Generate agent configs for all detected tools
  ai-agents install --tools=claude-code     # Install agents for Claude Code only
  ai-agents import                          # Import existing agents from detected tools
  ai-agents sync                            # Sync agents across all tools
`;

type Flags = {
  tools?: string;
  config?: string;
  verbose?: boolean;
  dryRun?: boolean;
  force?: boolean;
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

async function cmdInit(flags: Flags): Promise<void> {
  const { existsSync } = await import("node:fs");
  if (existsSync("ai-agents.config.ts")) {
    console.log("Config already exists: ai-agents.config.ts");
    return;
  }

  const { writeFile } = await import("node:fs/promises");

  const template = `import { defineConfig } from "@itz4blitz/ai-tools/agents";

export default defineConfig({
  agents: [
    // Add your agents here:
    //
    // {
    //   id: "reviewer",
    //   name: "Code Reviewer",
    //   description: "Reviews pull requests for correctness and maintainability",
    //   instructions: "Review code changes carefully for bugs, edge cases, and style.",
    // },
  ],
});
`;

  if (flags.dryRun) {
    console.log("[dry-run] Would create ai-agents.config.ts");
    return;
  }

  await writeFile("ai-agents.config.ts", template, "utf-8");
  console.log("Created ai-agents.config.ts");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit ai-agents.config.ts to add your agents");
  console.log("  2. Run: ai-agents detect    (see which AI tools are installed)");
  console.log("  3. Run: ai-agents install   (install agents into your tools)");
}

async function cmdDetect(flags: Flags): Promise<void> {
  void flags;
  console.log("Detecting AI coding tools with agent support...\n");

  const detected = await registry.detectAll();
  const all = registry.getAll();

  for (const adapter of all) {
    const isDetected = detected.some((d) => d.id === adapter.id);
    const icon = isDetected ? "\u2713" : "\u2717";
    const color = isDetected ? "\x1b[32m" : "\x1b[90m";
    const reset = "\x1b[0m";

    console.log(`  ${color}${icon}${reset} ${adapter.name.padEnd(20)} ${adapter.configDir}`);
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

  console.log(`Generating agent configs for ${adapters.length} tool(s)...\n`);

  for (const adapter of adapters) {
    const files = await adapter.generate(config.agents);

    for (const file of files) {
      if (flags.dryRun) {
        console.log(`  [dry-run] Would write: ${file.path}`);
      } else {
        console.log(`  Generated: ${file.path}`);
      }
    }

    if (!flags.dryRun) {
      await adapter.install(files);
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

  console.log(`Installing agents into ${adapters.length} tool(s)...\n`);

  for (const adapter of adapters) {
    const files = await adapter.generate(config.agents);

    if (flags.dryRun) {
      for (const file of files) {
        console.log(`  [dry-run] Would install: ${file.path}`);
      }
    } else {
      await adapter.install(files);
      console.log(`  \u2713 ${adapter.name}`);
    }
  }

  console.log("\nAgents installed!");
}

async function cmdImport(flags: Flags): Promise<void> {
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No AI tools detected. Use --tools to specify manually.");
    return;
  }

  console.log(`Importing agents from ${adapters.length} tool(s)...\n`);

  for (const adapter of adapters) {
    const agents = await adapter.import();

    if (agents.length === 0) {
      console.log(`  ${adapter.name}: no agents found`);
    } else {
      console.log(`  ${adapter.name}: ${agents.length} agent(s)`);
      for (const agent of agents) {
        console.log(`    - ${agent.name} (${agent.id})`);
      }
    }
  }
}

async function cmdSync(flags: Flags): Promise<void> {
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No AI tools detected. Use --tools to specify manually.");
    return;
  }

  // Import from first tool, generate for rest
  const source = adapters[0];
  if (!source) return;
  const agents = await source.import();

  console.log(
    `Syncing ${agents.length} agent(s) from ${source.name} to ${adapters.length - 1} tool(s)...\n`,
  );

  for (const adapter of adapters.slice(1)) {
    const files = await adapter.generate(agents);
    if (flags.dryRun) {
      for (const file of files) {
        console.log(`  [dry-run] Would write: ${file.path}`);
      }
    } else {
      await adapter.install(files);
      console.log(`  \u2713 ${adapter.name}`);
    }
  }

  console.log("\nDone!");
}

async function cmdExport(flags: Flags): Promise<void> {
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No AI tools detected. Use --tools to specify manually.");
    return;
  }

  const source = adapters[0];
  if (!source) return;
  const agents = await source.import();
  console.log(JSON.stringify({ agents }, null, 2));
}

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
    }
  }

  return flags;
}

async function loadConfig(configPath?: string): Promise<AgentsConfig> {
  const path = configPath ?? "ai-agents.config.ts";
  const { existsSync } = await import("node:fs");

  if (!existsSync(path)) {
    if (configPath) {
      throw new Error(`Config file not found: ${path}`);
    }
    return { agents: [] };
  }

  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const fullPath = resolve(process.cwd(), path);
  const mod = await import(pathToFileURL(fullPath).href);
  return mod.default as AgentsConfig;
}

async function resolveAdapters(flags: Flags): Promise<BaseAgentAdapter[]> {
  if (flags.tools) {
    const ids = flags.tools.split(",").map((t) => t.trim());
    const adapters: BaseAgentAdapter[] = [];
    for (const id of ids) {
      const adapter = registry.get(id);
      if (!adapter) {
        console.warn(`  Warning: Unknown adapter "${id}"`);
        continue;
      }
      if (!flags.force && !(await adapter.detect())) {
        console.warn(`  Warning: ${adapter.name} not detected, skipping (use --force to override)`);
        continue;
      }
      adapters.push(adapter);
    }
    return adapters;
  }

  return registry.detectAll();
}
