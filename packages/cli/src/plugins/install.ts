import { homedir } from "node:os";
import { buildPluginInstallPlan } from "./plan.js";
import { loadEngineRegistries } from "./runtime.js";
import type {
  AiPluginDefinition,
  InstalledPluginArtifact,
  InstallPluginOptions,
  InstallPluginResult,
  PluginEngine,
  PluginMCPServerDefinition,
} from "./types.js";

type PluginLayer = NonNullable<PluginMCPServerDefinition["layer"]>;

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function normalizePathSeparators(value: string): string {
  return value.replaceAll("\\", "/");
}

function filterPluginServers(
  servers: PluginMCPServerDefinition[],
  ctx: { layer: PluginLayer; cwd: string },
): PluginMCPServerDefinition[] {
  const normalizedCwd = normalizePathSeparators(ctx.cwd);
  return servers.filter((server) => {
    const layer = server.layer ?? "project";
    if (layer !== ctx.layer) return false;
    const fragments = server.whenPathContains ?? [];
    if (fragments.length === 0) return true;
    return fragments.some((fragment) => normalizedCwd.includes(normalizePathSeparators(fragment)));
  });
}

async function installEngine(
  registries: Awaited<ReturnType<typeof loadEngineRegistries>>,
  plugin: AiPluginDefinition,
  engine: PluginEngine,
  toolId: string,
  layer: PluginLayer,
): Promise<string[]> {
  switch (engine) {
    case "mcp": {
      const adapter = registries.mcp.get(toolId);
      if (!adapter) throw new Error(`Missing MCP adapter for ${toolId}`);
      const servers = filterPluginServers(plugin.mcpServers ?? [], {
        layer,
        cwd: process.cwd(),
      });
      if (servers.length === 0) return [];
      const files = await adapter.generate(servers);
      if (layer === "user") {
        if (adapter.userConfigPath) {
          for (const file of files) {
            file.path = adapter.userConfigPath;
          }
        }
        await adapter.install(files, homedir());
      } else {
        await adapter.install(files);
      }
      return files.map((file) => file.path);
    }
    case "skills": {
      const adapter = registries.skills.get(toolId);
      if (!adapter) throw new Error(`Missing skills adapter for ${toolId}`);
      if (layer === "user") {
        const files = await adapter.generate(plugin.skills ?? [], "user");
        await adapter.install(files, homedir());
        return files.map((file) => file.path);
      }
      const files = await adapter.generate(plugin.skills ?? []);
      await adapter.install(files);
      return files.map((file) => file.path);
    }
    case "rules": {
      const adapter = registries.rules.get(toolId);
      if (!adapter) throw new Error(`Missing rules adapter for ${toolId}`);
      const files = await adapter.generate(plugin.rules ?? []);
      await adapter.install(files);
      return files.map((file) => file.path);
    }
    case "agents": {
      const adapter = registries.agents.get(toolId);
      if (!adapter) throw new Error(`Missing agents adapter for ${toolId}`);
      const files = await adapter.generate(plugin.agents ?? []);
      await adapter.install(files);
      return files.map((file) => file.path);
    }
    case "hooks": {
      const adapter = registries.hooks.get(toolId);
      if (!adapter) throw new Error(`Missing hooks adapter for ${toolId}`);
      const files = await adapter.generate(plugin.hooks ?? []);
      await adapter.install(files);
      return files.map((file) => file.path);
    }
  }
}

export async function installPluginBundle(
  plugin: AiPluginDefinition,
  options: InstallPluginOptions = {},
): Promise<InstallPluginResult> {
  const registries = await loadEngineRegistries();
  const plan = await buildPluginInstallPlan(plugin, options);
  const installed: InstalledPluginArtifact[] = [];
  const failed: InstallPluginResult["failed"] = [];
  const layer: PluginLayer = options.layer ?? "project";

  if (options.dryRun) {
    return { plan, installed, failed };
  }

  for (const target of plan.targets) {
    for (const engine of target.engines) {
      if (engine.status !== "ready") continue;
      try {
        const filePaths = uniquePaths(
          await installEngine(registries, plugin, engine.engine, target.toolId, layer),
        );
        if (filePaths.length === 0) continue;
        installed.push({
          toolId: target.toolId,
          toolName: target.toolName,
          engine: engine.engine,
          filePaths,
        });
      } catch (error) {
        failed.push({
          toolId: target.toolId,
          toolName: target.toolName,
          engine: engine.engine,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { plan, installed, failed };
}
