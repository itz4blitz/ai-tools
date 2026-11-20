import { loadConfig, findConfigFile } from "../config/index.js";
import { HookEngine } from "../runtime/index.js";
import { registry } from "../adapters/registry.js";
import type { Adapter, GeneratedConfig } from "../types/index.js";

// Import all adapters to register them
import "../adapters/all.js";

const HELP = `
ai-hooks - Universal hooks framework for AI coding tools

USAGE:
  ai-hooks <command> [options]

COMMANDS:
  init        Create an ai-hooks.config.ts in the current directory
  detect      Detect which AI tools are installed
  generate    Generate native configs for detected/specified tools
  install     Generate and install hooks into detected tools
  uninstall   Remove ai-hooks from all detected tools
  list        List all registered hooks from your config
  status      Show current hook status across tools
  help        Show this help message

OPTIONS:
  --tools     Comma-separated list of tools (e.g., --tools=claude-code,cursor)
  --config    Path to config file (default: ai-hooks.config.ts)
  --verbose   Show detailed output
  --dry-run   Show what would be generated without writing files
  --force     Skip detection checks for --tools (install even if tool not found)

EXAMPLES:
  ai-hooks init                    # Create config file
  ai-hooks detect                  # See which AI tools are installed
  ai-hooks generate                # Generate configs for all detected tools
  ai-hooks install --tools=claude-code  # Install hooks for Claude Code only
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
    case "uninstall":
      await cmdUninstall(flags);
      break;
    case "list":
      await cmdList(flags);
      break;
    case "status":
      await cmdStatus(flags);
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
  const existing = findConfigFile();
  if (existing) {
    console.log(`Config already exists: ${existing}`);
    return;
  }

  const { writeFile } = await import("node:fs/promises");

  const template = `import { defineConfig, hook, builtinHooks } from "@itz4blitz/ai-tools/hooks";

export default defineConfig({
  // Start with built-in security hooks
  extends: [{ hooks: builtinHooks }],

  hooks: [
    // Add your custom hooks here:
    //
    // hook("before", ["shell:before"], async (ctx, next) => {
    //   console.log("Running:", ctx.event.command);
    //   await next();
    // })
    //   .id("my-hook")
    //   .name("Log Shell Commands")
    //   .build(),
  ],

  settings: {
    logLevel: "warn",
    hookTimeout: 5000,
    failMode: "open",
  },
});
`;

  if (flags.dryRun) {
    console.log("[dry-run] Would create ai-hooks.config.ts");
    return;
  }

  await writeFile("ai-hooks.config.ts", template, "utf-8");
  console.log("Created ai-hooks.config.ts");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit ai-hooks.config.ts to add your hooks");
  console.log("  2. Run: ai-hooks detect    (see which AI tools are installed)");
  console.log("  3. Run: ai-hooks install   (install hooks into your tools)");
}

async function cmdDetect(flags: Flags): Promise<void> {
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

    const caps: string[] = [];
    if (adapter.capabilities.beforeHooks) caps.push("hooks");
    if (adapter.capabilities.mcp) caps.push("mcp");

    let line = `  ${color}${icon}${reset} ${adapter.name.padEnd(20)} ${caps.join(", ")}`;
    if (flags.verbose) {
      line += `  (${adapter.capabilities.supportedEvents.length} events)`;
    }

    console.log(line);
  }

  console.log(`\nDetected ${detected.length}/${all.length} tools`);

  if (detected.length > 0 && !findConfigFile()) {
    console.log('\nRun "ai-hooks init" to create a config file');
  }
}

async function cmdGenerate(flags: Flags): Promise<void> {
  const config = await loadConfig(flags.config);
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No AI tools detected. Use --tools to specify manually.");
    return;
  }

  console.log(`Generating configs for ${adapters.length} tool(s)...\n`);

  for (const adapter of adapters) {
    const configs = await adapter.generate(config.hooks);

    for (const cfg of configs) {
      if (flags.dryRun) {
        console.log(`  [dry-run] Would write: ${cfg.path}`);
      } else {
        console.log(`  Generated: ${cfg.path}`);
      }
    }

    if (!flags.dryRun) {
      await writeConfigs(configs);
    }
  }

  console.log("\nDone!");
}

async function cmdInstall(flags: Flags): Promise<void> {
  const config = await loadConfig(flags.config);
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No AI tools detected. Use --tools to specify manually.");
    return;
  }

  console.log(`Installing hooks into ${adapters.length} tool(s)...\n`);

  for (const adapter of adapters) {
    const configs = await adapter.generate(config.hooks);

    if (flags.dryRun) {
      for (const cfg of configs) {
        console.log(`  [dry-run] Would install: ${cfg.path}`);
      }
    } else {
      await adapter.install(configs);
      console.log(`  \u2713 ${adapter.name}`);
    }
  }

  console.log("\nHooks installed!");
}

async function cmdUninstall(flags: Flags): Promise<void> {
  const adapters = await resolveAdapters(flags);

  for (const adapter of adapters) {
    await adapter.uninstall();
    console.log(`  \u2713 Removed from ${adapter.name}`);
  }

  console.log("\nHooks uninstalled.");
}

async function cmdList(flags: Flags): Promise<void> {
  const config = await loadConfig(flags.config);
  const engine = new HookEngine(config);
  const hooks = engine.getHooks();

  if (hooks.length === 0) {
    console.log("No hooks registered. Edit ai-hooks.config.ts to add hooks.");
    return;
  }

  console.log(`${hooks.length} hook(s) registered:\n`);

  for (const h of hooks) {
    const status = h.enabled === false ? "\x1b[90m(disabled)\x1b[0m" : "";
    const priority = h.priority ?? 100;
    console.log(`  [${h.phase}] ${h.name} ${status}`);
    console.log(`         id: ${h.id}  priority: ${priority}  events: ${h.events.join(", ")}`);
    if (h.description && flags.verbose) {
      console.log(`         ${h.description}`);
    }
    console.log("");
  }
}

async function cmdStatus(flags: Flags): Promise<void> {
  const hasConfig = findConfigFile();
  const detected = await registry.detectAll();

  console.log("ai-hooks status\n");
  console.log(`  Config: ${hasConfig ?? "not found"}`);
  console.log(`  Tools:  ${detected.length} detected`);

  if (hasConfig) {
    const config = await loadConfig(flags.config);
    const engine = new HookEngine(config);
    const hooks = engine.getHooks();
    console.log(`  Hooks:  ${hooks.length} registered`);
  }

  console.log("");

  for (const adapter of detected) {
    console.log(`  \u2713 ${adapter.name} (${adapter.id})`);
  }
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
    }
  }

  return flags;
}

async function resolveAdapters(flags: Flags): Promise<Adapter[]> {
  if (flags.tools) {
    const ids = flags.tools.split(",").map((t) => t.trim());
    const adapters: Adapter[] = [];
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

async function writeConfigs(configs: GeneratedConfig[]): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname, resolve } = await import("node:path");

  for (const cfg of configs) {
    const fullPath = resolve(process.cwd(), cfg.path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, cfg.content, "utf-8");
  }
}
