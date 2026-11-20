export type EngineStatus = {
  engine: string;
  detected: boolean;
  configured: boolean;
  configPath?: string;
  error?: string;
};

export type ToolDeployment = {
  adapterId: string;
  targetPath: string;
  strategy: "symlink" | "transform";
  status: "linked" | "stale" | "missing" | "direct";
};

export type ManifestHealth = {
  exists: boolean;
  entryCount: number;
  linkedCount: number;
  staleCount: number;
  missingCount: number;
};

export type ConfigDashboardData = {
  engines: EngineStatus[];
  deployments: ToolDeployment[];
  manifestHealth: ManifestHealth;
  mode: string;
  configHealth: string;
};

/**
 * Known engine names and their config file globs.
 */
const ENGINES: Record<string, { configFiles: string[] }> = {
  hooks: { configFiles: ["ai-hooks.config.ts", "ai-hooks.config.js"] },
  mcp: { configFiles: ["mcp.config.ts", "mcp.config.js", "ai-mcp.config.ts", "ai-mcp.config.js"] },
  skills: { configFiles: ["ai-skills.config.ts", "ai-skills.config.js"] },
  agents: { configFiles: ["ai-agents.config.ts", "ai-agents.config.js"] },
  rules: { configFiles: ["ai-rules.config.ts", "ai-rules.config.js"] },
};

/**
 * Get the status of each engine's configuration.
 * Checks for config files in both the current working directory and .ai-tools/.
 */
export async function getEngineStatus(): Promise<EngineStatus[]> {
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const cwd = process.cwd();
  const canonicalDir = resolve(cwd, ".ai-tools");
  const results: EngineStatus[] = [];

  for (const [engine, meta] of Object.entries(ENGINES)) {
    let configured = false;
    let configPath: string | undefined;

    // Check root config files
    for (const file of meta.configFiles) {
      const fullPath = resolve(cwd, file);
      if (existsSync(fullPath)) {
        configured = true;
        configPath = fullPath;
        break;
      }
    }

    // Also check .ai-tools/ canonical directory
    if (!configured && existsSync(canonicalDir)) {
      for (const file of meta.configFiles) {
        const fullPath = resolve(canonicalDir, file);
        if (existsSync(fullPath)) {
          configured = true;
          configPath = fullPath;
          break;
        }
      }
      // Check for engine-named subdirectory or JSON config
      const engineJson = resolve(canonicalDir, `${engine}.json`);
      if (!configured && existsSync(engineJson)) {
        configured = true;
        configPath = engineJson;
      }
    }

    results.push({
      engine,
      detected: configured,
      configured,
      ...(configPath ? { configPath } : {}),
    });
  }

  return results;
}

/** Local types matching the CLI manifest schema (avoid circular dependency). */
type ManifestTarget = {
  adapterId: string;
  targetPath: string;
  strategy: "symlink" | "transform";
  status: "linked" | "stale" | "missing" | "direct";
};

type ManifestEntry = {
  engine: string;
  id: string;
  canonicalPath: string;
  targets: ManifestTarget[];
  updatedAt: string;
};

type Manifest = {
  version: number;
  entries: ManifestEntry[];
};

/**
 * Read .ai-tools/manifest.json and flatten all targets into ToolDeployment[].
 */
export async function getToolDeployments(): Promise<ToolDeployment[]> {
  const { readFileSync, existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const manifestPath = resolve(process.cwd(), ".ai-tools", "manifest.json");
  if (!existsSync(manifestPath)) return [];

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw) as Manifest;
    const deployments: ToolDeployment[] = [];

    for (const entry of manifest.entries) {
      for (const target of entry.targets) {
        deployments.push({
          adapterId: target.adapterId,
          targetPath: target.targetPath,
          strategy: target.strategy,
          status: target.status,
        });
      }
    }

    return deployments;
  } catch {
    return [];
  }
}

/**
 * Compute manifest health from deployments.
 */
export async function computeManifestHealth(
  deployments: ToolDeployment[],
): Promise<ManifestHealth> {
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const manifestPath = resolve(process.cwd(), ".ai-tools", "manifest.json");
  const exists = existsSync(manifestPath);

  let linkedCount = 0;
  let staleCount = 0;
  let missingCount = 0;

  for (const d of deployments) {
    switch (d.status) {
      case "linked":
      case "direct":
        linkedCount++;
        break;
      case "stale":
        staleCount++;
        break;
      case "missing":
        missingCount++;
        break;
    }
  }

  return {
    exists,
    entryCount: deployments.length,
    linkedCount,
    staleCount,
    missingCount,
  };
}

/**
 * Orchestrate all config dashboard data into a single object.
 */
export async function getConfigDashboardData(mode: string): Promise<ConfigDashboardData> {
  const [engines, deployments] = await Promise.all([getEngineStatus(), getToolDeployments()]);

  const manifestHealth = await computeManifestHealth(deployments);

  // Compute health based on manifest state
  let configHealth: string;
  if (!manifestHealth.exists && mode === "canonical") {
    configHealth = "error";
  } else if (manifestHealth.staleCount > 0 || manifestHealth.missingCount > 0) {
    configHealth = "stale";
  } else if (manifestHealth.entryCount > 0 || engines.some((e) => e.configured)) {
    configHealth = "healthy";
  } else if (mode === "direct") {
    configHealth = "healthy";
  } else {
    configHealth = "error";
  }

  return {
    engines,
    deployments,
    manifestHealth,
    mode,
    configHealth,
  };
}

/**
 * Format an engine status entry into a display row.
 */
export function formatEngineRow(engine: string, status: EngineStatus): string {
  void engine;
  const icon = status.configured ? "\u2713" : "\u2717";
  const state = status.configured ? "configured" : "not configured";
  const errorSuffix = status.error ? ` (${status.error})` : "";
  return `${icon} ${status.engine.padEnd(12)} ${state}${errorSuffix}`;
}
