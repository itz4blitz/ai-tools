import { registry } from "../adapters/registry.js";
import type { BaseRuleAdapter } from "../adapters/base.js";
import type { RulesConfig } from "../types/index.js";

import "../adapters/all.js";

const HELP = `
ai-rules - Universal project rules configuration for AI coding tools

USAGE:
  ai-rules <command> [options]

COMMANDS:
  init        Create an ai-rules.config.ts in the current directory
  detect      Detect which AI tools have rules configured
  generate    Generate rule files for detected/specified tools
  install     Generate and install rules into detected tools
  import      Import existing rules from a tool
  sync        Sync rules across all detected tools
  export      Export rules to stdout as JSON
  help        Show this help message

OPTIONS:
  --tools     Comma-separated list of tools (e.g., --tools=claude-code,cursor)
  --from      Source tool for import/sync (e.g., --from=claude-code)
  --config    Path to config file (default: ai-rules.config.ts)
  --dry-run   Show what would be generated without writing files
  --force     Skip detection checks for --tools (install even if tool not found)

EXAMPLES:
  ai-rules init                          # Create config file
  ai-rules detect                        # See which tools have rules
  ai-rules generate --tools=claude-code  # Generate rules for Claude Code
  ai-rules sync --from=claude-code       # Sync rules from Claude Code to all tools
`;

type Flags = {
  tools?: string;
  from?: string;
  config?: string;
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
      await cmdDetect();
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
  const { writeFile } = await import("node:fs/promises");

  const template = `import { defineRulesConfig } from "@itz4blitz/ai-tools/rules";

export default defineRulesConfig({
  rules: [
    // {
    //   id: "typescript",
    //   name: "TypeScript Standards",
    //   description: "TypeScript coding standards",
    //   content: "Always use strict TypeScript. No any types.",
    //   scope: { type: "glob", patterns: ["*.ts", "*.tsx"] },
    // },
  ],
});
`;

  if (flags.dryRun) {
    console.log("[dry-run] Would create ai-rules.config.ts");
    return;
  }

  await writeFile("ai-rules.config.ts", template, "utf-8");
  console.log("Created ai-rules.config.ts");
}

async function cmdDetect(): Promise<void> {
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

    console.log(`  ${color}${icon}${reset} ${adapter.name.padEnd(20)} ${adapter.configDir}`);
  }

  console.log(`\nDetected ${detected.length}/${all.length} tools`);
}

async function cmdGenerate(flags: Flags): Promise<void> {
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No tools specified. Use --tools to specify tools.");
    return;
  }

  const config = await loadConfig(flags.config);

  console.log(`Generating rules for ${adapters.length} tool(s)...\n`);

  for (const adapter of adapters) {
    const files = await adapter.generate(config.rules);

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
    console.log("No tools specified. Use --tools to specify tools.");
    return;
  }

  const config = await loadConfig(flags.config);

  console.log(`Installing rules into ${adapters.length} tool(s)...\n`);

  for (const adapter of adapters) {
    const files = await adapter.generate(config.rules);

    if (flags.dryRun) {
      for (const file of files) {
        console.log(`  [dry-run] Would install: ${file.path}`);
      }
    } else {
      await adapter.install(files);
      console.log(`  \u2713 ${adapter.name}`);
    }
  }

  console.log("\nRules installed!");
}

async function cmdImport(flags: Flags): Promise<void> {
  const fromId = flags.from;
  if (!fromId) {
    console.log("Specify source tool with --from (e.g., --from=claude-code)");
    return;
  }

  const adapter = registry.get(fromId);
  if (!adapter) {
    console.error(`Unknown tool: ${fromId}`);
    return;
  }

  const rules = await adapter.import();
  console.log(`Imported ${rules.length} rule(s) from ${adapter.name}`);

  for (const rule of rules) {
    console.log(`  - ${rule.name} (${rule.id})`);
  }
}

async function cmdSync(flags: Flags): Promise<void> {
  const fromId = flags.from;
  if (!fromId) {
    console.log("Specify source tool with --from (e.g., --from=claude-code)");
    return;
  }

  const source = registry.get(fromId);
  if (!source) {
    console.error(`Unknown tool: ${fromId}`);
    return;
  }

  const rules = await source.import();
  console.log(`Imported ${rules.length} rule(s) from ${source.name}`);

  const targets = (await resolveAdapters(flags)).filter((a) => a.id !== fromId);

  for (const target of targets) {
    const files = await target.generate(rules);
    if (flags.dryRun) {
      for (const f of files) {
        console.log(`  [dry-run] ${target.name}: ${f.path}`);
      }
    } else {
      await target.install(files);
      console.log(`  \u2713 ${target.name} (${files.length} files)`);
    }
  }
}

async function cmdExport(flags: Flags): Promise<void> {
  const fromId = flags.from;
  if (!fromId) {
    console.log("Specify source tool with --from (e.g., --from=claude-code)");
    return;
  }

  const adapter = registry.get(fromId);
  if (!adapter) {
    console.error(`Unknown tool: ${fromId}`);
    return;
  }

  const rules = await adapter.import();
  console.log(JSON.stringify(rules, null, 2));
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};
  for (const arg of args) {
    if (arg.startsWith("--tools=")) {
      flags.tools = arg.slice(8);
    } else if (arg.startsWith("--from=")) {
      flags.from = arg.slice(7);
    } else if (arg.startsWith("--config=")) {
      flags.config = arg.slice(9);
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--force") {
      flags.force = true;
    }
  }
  return flags;
}

async function loadConfig(configPath?: string): Promise<RulesConfig> {
  const path = configPath ?? "ai-rules.config.ts";
  const { existsSync } = await import("node:fs");

  if (!existsSync(path)) {
    if (configPath) {
      throw new Error(`Config file not found: ${path}`);
    }
    return { rules: [] };
  }

  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const fullPath = resolve(process.cwd(), path);
  const mod = await import(pathToFileURL(fullPath).href);
  return mod.default as RulesConfig;
}

async function resolveAdapters(flags: Flags): Promise<BaseRuleAdapter[]> {
  if (flags.tools) {
    const ids = flags.tools.split(",").map((t) => t.trim());
    const adapters: BaseRuleAdapter[] = [];
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
