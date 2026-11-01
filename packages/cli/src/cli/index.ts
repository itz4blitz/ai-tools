function buildHelp(cliName: string): string {
  return `
${cliName} - Unified CLI for ai-tools engines and portable plugin bundles

USAGE:
  ${cliName} <engine> <command> [options]
  ${cliName} <cross-cutting-command> [options]

ENGINES:
  hooks       Lifecycle hooks for AI coding tools
  mcp         MCP server configuration
  skills      Skills/prompts configuration
  agents      Agent configuration
  rules       Project rules configuration
  plugins     Portable capability bundle planning and install
  sessions    Cross-tool session reading and handoff

CROSS-CUTTING COMMANDS:
  detect      Run detect across all engines
  help        Show this help message

INTERACTIVE:
  ui          Launch interactive terminal dashboard

CANONICAL MODE COMMANDS:
  init        Initialize .ai-tools/ directory (canonical mode)
  generate    Generate canonical files from engine configs
  install     Install engine configs into detected tool directories
  status      Show installation mode and health
  clean       Remove tool-specific directories

ENGINE COMMANDS:
  Pass any command supported by the engine's CLI.
  Example: ${cliName} mcp install --tools=claude-code

OPTIONS:
  --tools     Comma-separated list of tools (forwarded to engine)
  --dry-run   Show what would happen without writing files
  --layer     user or project (MCP install/sync and skills; forwarded)

EXAMPLES:
  ${cliName} mcp detect                     # Detect MCP-capable tools
  ${cliName} mcp install --layer=project    # Install from mcp.config.ts
  ${cliName} mcp sync --layer=project       # Config-scoped MCP install (never copies imports)
  ${cliName} mcp audit                      # Scan user-global MCP configs for leaks
  ${cliName} detect                         # Detect across all engines
  ${cliName} plugins plan --tools=cursor,codex,opencode
  ${cliName} hooks init                     # Initialize hooks config
  ${cliName} init                           # Initialize canonical mode
  ${cliName} generate                       # Generate canonical files
  ${cliName} install                        # Install to tool directories
  ${cliName} status                         # Check installation health
  ${cliName} clean                          # Remove tool directories
`;
}

type EngineEntry = {
  name: string;
  pkg: string;
};

const ENGINES: Record<string, EngineEntry> = {
  hooks: { name: "hooks", pkg: "@itz4blitz/ai-tools-hooks/cli" },
  mcp: { name: "mcp", pkg: "@itz4blitz/ai-tools-mcp/cli" },
  skills: { name: "skills", pkg: "@itz4blitz/ai-tools-skills/cli" },
  agents: { name: "agents", pkg: "@itz4blitz/ai-tools-agents/cli" },
  rules: { name: "rules", pkg: "@itz4blitz/ai-tools-rules/cli" },
  plugins: { name: "plugins", pkg: "./plugins" },
  sessions: { name: "sessions", pkg: "@itz4blitz/ai-tools-sessions/cli" },
};

const ENGINE_NAMES = Object.keys(ENGINES);

async function loadEngine(pkg: string): Promise<{ run: (args: string[]) => Promise<void> }> {
  if (pkg === "./plugins") {
    return import("../plugins/cli.js") as Promise<{ run: (args: string[]) => Promise<void> }>;
  }
  return import(pkg) as Promise<{ run: (args: string[]) => Promise<void> }>;
}

async function loadUi(): Promise<{ run: (args: string[]) => Promise<void> }> {
  const pkg = "@itz4blitz/ai-tools-tui/cli";
  return import(pkg) as Promise<{ run: (args: string[]) => Promise<void> }>;
}

export async function run(args: string[]): Promise<void> {
  const cliName = "ai-tools";
  const help = buildHelp(cliName);
  const command = args[0];

  switch (command) {
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(help);
      return;

    case "detect":
      await crossCutDetect(args.slice(1));
      return;

    case "sync":
      console.error(
        "Unified sync is disabled. It used to copy imported servers between every tool.",
      );
      console.error(
        "Use `ai-tools mcp sync` to install from mcp.config.ts (never copies imports; honors --layer).",
      );
      process.exit(1);
      return;

    case "init":
      await (await import("../canonical/commands.js")).cmdInit(args.slice(1));
      return;

    case "generate":
      await (await import("../canonical/commands.js")).cmdGenerate(args.slice(1));
      return;

    case "install":
      await (await import("../canonical/commands.js")).cmdInstall(args.slice(1));
      return;

    case "status":
      await (await import("../canonical/commands.js")).cmdStatus(args.slice(1));
      return;

    case "clean":
      await (await import("../canonical/commands.js")).cmdClean(args.slice(1));
      return;

    case "ui":
      await (await loadUi()).run(args.slice(1));
      return;

    default:
      // Check if it's an engine name
      if (command in ENGINES) {
        const engine = ENGINES[command];
        if (engine) {
          const mod = await loadEngine(engine.pkg);
          await mod.run(args.slice(1));
          return;
        }
      }

      // Unknown command
      console.error(`Unknown command: ${command}`);
      console.log(help);
      process.exit(1);
  }
}

async function crossCutDetect(flags: string[]): Promise<void> {
  for (const name of ENGINE_NAMES) {
    const engine = ENGINES[name];
    if (!engine) continue;
    console.log(`\n── ${engine.name} ──`);
    try {
      const mod = await loadEngine(engine.pkg);
      await mod.run(["detect", ...flags]);
    } catch (err) {
      console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
