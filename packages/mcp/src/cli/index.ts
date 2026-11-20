import { homedir } from "node:os";
import { registry } from "../adapters/registry.js";
import type { BaseMCPAdapter } from "../adapters/base.js";
import type { MCPServerDefinition, MCPConfig } from "../types/index.js";
import { filterServers } from "../scope.js";
import { auditServers } from "../audit.js";

// Import all adapters to register them
import "../adapters/all.js";

const HELP = `
ai-mcp - Universal MCP server configuration for AI coding tools

USAGE:
  ai-mcp <command> [options]

COMMANDS:
  init        Create an mcp.config.ts in the current directory
  detect      Detect which AI tools support MCP
  generate    Generate MCP configs for detected/specified tools
  install     Generate and install MCP servers into detected tools
  import      Import MCP servers from an existing tool's config
  sync        Install servers from mcp.config.ts onto detected tools (never copies imports)
  export      Export MCP server definitions as JSON
  audit       Find org-specific / interactive-1Password leaks in user-global configs
  help        Show this help message

OPTIONS:
  --tools     Comma-separated list of tools (e.g., --tools=claude-code,cursor)
  --dry-run   Show what would be generated without writing files
  --force     Skip detection checks for --tools (install even if tool not found)
  --layer     user or project (default: project). Controls which servers install.

EXAMPLES:
  ai-mcp detect                          # See which AI tools support MCP
  ai-mcp generate                        # Generate configs for all detected tools
  ai-mcp install --tools=claude-code     # Install MCP servers for Claude Code only
  ai-mcp install --layer=project         # Project-scoped install from mcp.config.ts
  ai-mcp sync --layer=project            # Config-scoped install (never copies imports)
  ai-mcp audit                           # Scan user-global MCP configs for leaks
  ai-mcp import --tools=claude-code      # Import servers from Claude Code config
  ai-mcp export                          # Export all MCP servers as JSON
`;

type Flags = {
  tools?: string;
  config?: string;
  dryRun?: boolean;
  force?: boolean;
  layer?: "user" | "project";
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
    case "audit":
      await cmdAudit(flags);
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
  const { writeFile } = await import("node:fs/promises");

  const template = `import { defineConfig } from "@itz4blitz/ai-tools/mcp";

export default defineConfig({
  servers: [
    // Add your MCP servers here:
    // {
    //   id: "my-server",
    //   name: "My MCP Server",
    //   transport: {
    //     type: "stdio",
    //     command: "npx",
    //     args: ["-y", "@my-org/mcp-server"],
    //   },
    // },
  ],
});
`;

  if (flags.dryRun) {
    console.log("[dry-run] Would create mcp.config.ts");
    return;
  }

  await writeFile("mcp.config.ts", template, "utf-8");
  console.log("Created mcp.config.ts");
  console.log("");
  console.log("Next steps:");
  console.log("  1. Edit mcp.config.ts to add your MCP servers");
  console.log("  2. Run: ai-mcp detect    (see which AI tools support MCP)");
  console.log("  3. Run: ai-mcp install   (install servers into your tools)");
}

async function cmdDetect(): Promise<void> {
  console.log("Detecting AI coding tools with MCP support...\n");

  const detected = await registry.detectAll();
  const all = registry.list();

  for (const id of all) {
    const adapter = registry.get(id);
    if (!adapter) continue;

    const isDetected = detected.some((d) => d.id === id);
    const icon = isDetected ? "\u2713" : "\u2717";
    const color = isDetected ? "\x1b[32m" : "\x1b[90m";
    const reset = "\x1b[0m";

    console.log(`  ${color}${icon}${reset} ${adapter.name}`);
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
  const servers = requireConfiguredServers(selectServers(config.servers, flags), "write");
  const layer = flags.layer ?? "project";

  console.log(`Generating MCP configs for ${adapters.length} tool(s)...\n`);

  for (const adapter of adapters) {
    if (layer === "project" && adapter.scope === "user-only") {
      console.log(`  - ${adapter.name}: skipped (user-only host; use --layer=user to generate)`);
      continue;
    }

    try {
      const files = await adapter.generate(servers);
      if (layer === "user" && adapter.userConfigPath) {
        for (const file of files) {
          file.path = adapter.userConfigPath;
        }
      }

      if (flags.dryRun) {
        for (const file of files) {
          console.log(`  [dry-run] Would write: ${file.path}`);
        }
      } else {
        await adapter.install(files, layer === "user" ? homedir() : process.cwd());
        for (const file of files) {
          console.log(`  Generated: ${file.path}`);
        }
      }
    } catch (err) {
      if (adapters.length === 1) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  \u2717 ${adapter.name}: skipped (${message})`);
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
  const servers = requireConfiguredServers(selectServers(config.servers, flags), "write");
  const layer = flags.layer ?? "project";

  console.log(`Installing MCP servers into ${adapters.length} tool(s)...\n`);

  for (const adapter of adapters) {
    if (layer === "project" && adapter.scope === "user-only") {
      console.log(`  - ${adapter.name}: skipped (user-only host; use --layer=user to install)`);
      continue;
    }

    try {
      const files = await adapter.generate(servers);
      if (layer === "user" && adapter.userConfigPath) {
        for (const file of files) {
          file.path = adapter.userConfigPath;
        }
      }

      if (flags.dryRun) {
        for (const file of files) {
          console.log(`  [dry-run] Would install: ${file.path}`);
        }
      } else {
        await adapter.install(files, layer === "user" ? homedir() : process.cwd());
        console.log(`  \u2713 ${adapter.name}`);
      }
    } catch (err) {
      if (adapters.length === 1) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  \u2717 ${adapter.name}: skipped (${message})`);
    }
  }

  console.log("\nMCP servers installed!");
}

async function cmdImport(flags: Flags): Promise<void> {
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No AI tools detected. Use --tools to specify manually.");
    return;
  }

  for (const adapter of adapters) {
    const servers = await adapter.import();
    console.log(`  Imported ${servers.length} server(s) from ${adapter.name}`);
  }
}

async function cmdSync(flags: Flags): Promise<void> {
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No AI tools detected. Use --tools to specify manually.");
    return;
  }

  const config = await loadConfig(flags.config);
  const servers = requireConfiguredServers(selectServers(config.servers, flags), "sync");

  console.log(
    `Installing ${servers.length} configured server(s) onto ${adapters.length} tool(s)...\n`,
  );

  const layer = flags.layer ?? "project";
  for (const adapter of adapters) {
    if (layer === "project" && adapter.scope === "user-only") {
      console.log(`  - ${adapter.name}: skipped (user-only host; use --layer=user to install)`);
      continue;
    }

    try {
      const files = await adapter.generate(servers);
      if (layer === "user" && adapter.userConfigPath) {
        for (const file of files) {
          file.path = adapter.userConfigPath;
        }
      }
      if (flags.dryRun) {
        for (const file of files) {
          console.log(`  [dry-run] Would write: ${file.path}`);
        }
      } else {
        await adapter.install(files, layer === "user" ? homedir() : process.cwd());
        console.log(`  \u2713 ${adapter.name}`);
      }
    } catch (err) {
      if (adapters.length === 1) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  \u2717 ${adapter.name}: skipped (${message})`);
    }
  }

  console.log("\nSync complete!");
}

async function cmdExport(flags: Flags): Promise<void> {
  const adapters = await resolveAdapters(flags);

  if (adapters.length === 0) {
    console.log("No AI tools detected. Use --tools to specify manually.");
    return;
  }

  const allServers = new Map<string, MCPServerDefinition>();
  for (const adapter of adapters) {
    const servers = await adapter.import();
    for (const server of servers) {
      if (!allServers.has(server.id)) {
        allServers.set(server.id, server);
      }
    }
  }

  console.log(JSON.stringify([...allServers.values()], null, 2));
}

async function cmdAudit(flags: Flags): Promise<void> {
  const adapters = flags.tools
    ? await resolveAdapters({ ...flags, force: true })
    : registry.getAll();

  const findings = [];
  for (const adapter of adapters) {
    const servers = await adapter.importUser();
    findings.push(...auditServers(adapter.id, servers, "user"));
  }

  if (findings.length === 0) {
    console.log("No PalamHealth user-global MCP leaks found.");
    return;
  }

  console.log(`Found ${findings.length} MCP leak(s):\n`);
  for (const finding of findings) {
    console.log(`  [${finding.kind}] ${finding.tool}/${finding.server}: ${finding.detail}`);
  }
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};

  for (const arg of args) {
    if (arg.startsWith("--tools=")) {
      flags.tools = arg.slice(8);
    } else if (arg.startsWith("--config=")) {
      flags.config = arg.slice(9);
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--force") {
      flags.force = true;
    } else if (arg.startsWith("--layer=")) {
      const layer = arg.slice(8);
      if (layer === "user" || layer === "project") flags.layer = layer;
    }
  }

  return flags;
}

async function resolveAdapters(flags: Flags): Promise<BaseMCPAdapter[]> {
  if (flags.tools) {
    const ids = flags.tools.split(",").map((t) => t.trim());
    const adapters: BaseMCPAdapter[] = [];
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

async function loadConfig(configPath?: string): Promise<MCPConfig> {
  const path = configPath ?? "mcp.config.ts";
  const { existsSync } = await import("node:fs");

  if (!existsSync(path)) {
    if (configPath) {
      throw new Error(`Config file not found: ${path}`);
    }
    return { servers: [] };
  }

  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const fullPath = resolve(process.cwd(), path);
  const mod = await import(pathToFileURL(fullPath).href);
  return mod.default as MCPConfig;
}

function selectServers(servers: MCPServerDefinition[], flags: Flags): MCPServerDefinition[] {
  return filterServers(servers, {
    layer: flags.layer ?? "project",
    cwd: process.cwd(),
  });
}

function requireConfiguredServers(
  servers: MCPServerDefinition[],
  mode: "sync" | "write",
): MCPServerDefinition[] {
  if (servers.length > 0) return servers;
  if (mode === "sync") {
    console.error(
      "No servers to sync from mcp.config.ts. Refusing to copy imported servers between tools.",
    );
  } else {
    console.error("No servers selected from mcp.config.ts. Refusing to write an empty MCP config.");
  }
  console.error(
    "Add servers to the config (or pass --config) and use install/sync from that list.",
  );
  process.exit(1);
  return servers;
}
