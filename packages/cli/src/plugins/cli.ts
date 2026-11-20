import { KNOWN_PLUGIN_HOSTS } from "./hosts.js";
import { installPluginBundle } from "./install.js";
import { loadPluginConfig } from "./load-config.js";
import { buildPluginInstallPlan } from "./plan.js";
import type { AiPluginDefinition, EngineInstallPlan, PluginTargetPlan } from "./types.js";

const HELP = `
ai-tools plugins - Portable AI tool capability bundles

USAGE:
  ai-tools plugins <command> [options]
  ai-tools plugin <command> [options]

COMMANDS:
  init        Create an ai-plugin.config.ts in the current directory
  detect      Show known host targets and whether they are detected
  plan        Show how a plugin bundle maps onto selected hosts
  install     Install supported plugin capabilities into selected hosts
  help        Show this help message

OPTIONS:
  --config    Path to plugin config file (default: ai-plugin.config.ts)
  --tools     Comma-separated list of tools (e.g., --tools=cursor,codex,opencode)
  --dry-run   Show what would be installed without writing files
  --force     Include selected tools even when they are not detected locally
  --layer     project (default) or user (MCP servers and skills)

EXAMPLES:
  ai-tools plugins init
  ai-tools plugins detect
  ai-tools plugins plan --tools=cursor,codex,opencode
  ai-tools plugins install --tools=cursor,codex --dry-run
`;

type Flags = {
  config?: string;
  tools?: string;
  dryRun?: boolean;
  force?: boolean;
  layer?: "project" | "user";
};

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};

  for (const arg of args) {
    if (arg.startsWith("--config=")) {
      flags.config = arg.slice(9);
    } else if (arg.startsWith("--tools=")) {
      flags.tools = arg.slice(8);
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

function parseTools(flags: Flags): string[] | undefined {
  return flags.tools
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatEnginePlan(plan: EngineInstallPlan): string {
  if (!plan.requested) return `  - ${plan.engine}: not requested`;
  return `  - ${plan.engine}: ${plan.status}`;
}

function printTarget(target: PluginTargetPlan): void {
  console.log(`- ${target.toolName} (${target.toolId})`);
  console.log(`  detected: ${target.detected ? "yes" : "no"}`);
  console.log(`  installable: ${target.installable ? "yes" : "no"}`);
  console.log(`  interactive UI: ${target.host.supportsInteractiveApps ? "yes" : "no"}`);
  console.log(`  native bundles: ${target.host.supportsNativeBundles ? "yes" : "no"}`);
  console.log(`  notes: ${target.host.notes}`);
  for (const engine of target.engines) {
    console.log(formatEnginePlan(engine));
  }
}

async function cmdInit(flags: Flags): Promise<void> {
  const outputPath = flags.config ?? "ai-plugin.config.ts";
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname, resolve } = await import("node:path");

  const template = `import { definePlugin } from "@itz4blitz/ai-tools";

export default definePlugin({
  id: "my-plugin",
  name: "My Plugin",
  version: "0.1.0",
  description: "Portable AI tool capability bundle.",
  targets: {
    include: ["cursor", "codex", "opencode", "claude-code"],
  },
  mcpServers: [
    {
      id: "example-server",
      name: "Example Server",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      },
    },
  ],
  skills: [
    {
      id: "example-skill",
      name: "Example Skill",
      description: "Reusable workflow for your agent.",
      content: "Use this skill when the user asks for the example workflow.",
    },
  ],
});
`;

  if (flags.dryRun) {
    console.log(`[dry-run] Would create ${outputPath}`);
    return;
  }

  const fullPath = resolve(process.cwd(), outputPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, template, "utf-8");
  console.log(`Created ${outputPath}`);
}

async function cmdDetect(): Promise<void> {
  const plan = await buildPluginInstallPlan(
    {
      id: "detect-only",
      name: "Detect Only",
      version: "0.0.0",
    },
    {
      tools: Object.keys(KNOWN_PLUGIN_HOSTS),
      force: true,
    },
  );

  console.log("Known portable hosts:\n");
  for (const target of plan.targets) {
    console.log(`- ${target.toolName} (${target.toolId})`);
    console.log(`  detected: ${target.detected ? "yes" : "no"}`);
    console.log(`  interactive UI: ${target.host.supportsInteractiveApps ? "yes" : "no"}`);
    console.log(`  native bundles: ${target.host.supportsNativeBundles ? "yes" : "no"}`);
    console.log(`  notes: ${target.host.notes}`);
  }
}

async function cmdPlan(flags: Flags): Promise<void> {
  const plugin = await loadPluginConfig(flags.config);
  const plan = await buildPluginInstallPlan(plugin, {
    tools: parseTools(flags),
    force: flags.force,
  });

  printPlan(plugin, plan);
}

function printPlan(
  plugin: AiPluginDefinition,
  plan: Awaited<ReturnType<typeof buildPluginInstallPlan>>,
): void {
  console.log(`${plugin.name} (${plugin.id}) v${plugin.version}`);
  if (plugin.description) {
    console.log(plugin.description);
  }
  console.log("");
  console.log(
    `Requested engines: ${plan.requestedEngines.length ? plan.requestedEngines.join(", ") : "none"}`,
  );
  console.log("");
  for (const target of plan.targets) {
    printTarget(target);
  }
}

async function cmdInstall(flags: Flags): Promise<void> {
  const plugin = await loadPluginConfig(flags.config);
  const result = await installPluginBundle(plugin, {
    tools: parseTools(flags),
    force: flags.force,
    dryRun: flags.dryRun,
    layer: flags.layer,
  });

  printPlan(plugin, result.plan);

  if (flags.dryRun) {
    console.log("\n[dry-run] No files were written.");
    return;
  }

  console.log("");
  if (result.installed.length > 0) {
    console.log("Installed artifacts:");
    for (const artifact of result.installed) {
      console.log(`- ${artifact.toolName} (${artifact.engine})`);
      for (const filePath of artifact.filePaths) {
        console.log(`  ${filePath}`);
      }
    }
  } else {
    console.log("No plugin artifacts were installed.");
  }

  if (result.failed.length > 0) {
    console.log("\nFailures:");
    for (const failure of result.failed) {
      console.log(`- ${failure.toolName} (${failure.engine}): ${failure.error}`);
    }
    process.exit(1);
  }
}

export async function run(args: string[]): Promise<void> {
  const command = args[0];
  const flags = parseFlags(args.slice(1));

  switch (command) {
    case "init":
      await cmdInit(flags);
      return;
    case "detect":
      await cmdDetect();
      return;
    case "plan":
      await cmdPlan(flags);
      return;
    case "install":
      await cmdInstall(flags);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return;
    default:
      console.error(`Unknown plugins command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}
