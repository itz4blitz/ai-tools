import type { AiPluginDefinition } from "./types.js";

export async function toPluginConfigModuleSpecifier(path: string): Promise<string> {
  const { resolve } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  return pathToFileURL(resolve(process.cwd(), path)).href;
}

export async function loadPluginConfig(configPath?: string): Promise<AiPluginDefinition> {
  const path = configPath ?? "ai-plugin.config.ts";
  const { existsSync } = await import("node:fs");

  if (!existsSync(path)) {
    throw new Error(`Plugin config not found: ${path}`);
  }

  const mod = (await import(await toPluginConfigModuleSpecifier(path))) as { default?: unknown };
  if (!mod.default || typeof mod.default !== "object" || Array.isArray(mod.default)) {
    throw new Error(
      `Plugin config at ${path} must have a default export object (e.g. export default definePlugin({ ... }))`,
    );
  }
  return mod.default as AiPluginDefinition;
}
