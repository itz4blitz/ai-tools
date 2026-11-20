import type { PluginEngine } from "./types.js";

type DetectableAdapter = {
  id: string;
  detect(cwd?: string): Promise<boolean>;
};

type GeneratedFileLike = {
  path: string;
  content: string;
  format: string;
};

type McpAdapter = DetectableAdapter & {
  userConfigPath?: string;
  generate(servers: unknown[]): Promise<GeneratedFileLike[]>;
  install(files: GeneratedFileLike[], cwd?: string): Promise<void>;
};

type SkillsAdapter = DetectableAdapter & {
  generate(skills: unknown[], layer?: "project" | "user"): Promise<GeneratedFileLike[]>;
  install(files: GeneratedFileLike[], cwd?: string): Promise<void>;
};

type RulesAdapter = DetectableAdapter & {
  generate(rules: unknown[]): Promise<GeneratedFileLike[]>;
  install(files: GeneratedFileLike[]): Promise<void>;
};

type AgentsAdapter = DetectableAdapter & {
  generate(agents: unknown[]): Promise<GeneratedFileLike[]>;
  install(files: GeneratedFileLike[]): Promise<void>;
};

type HooksAdapter = DetectableAdapter & {
  generate(hooks: unknown[]): Promise<GeneratedFileLike[]>;
  install(files: GeneratedFileLike[]): Promise<void>;
};

type Registry<TAdapter extends DetectableAdapter> = {
  list(): string[];
  get(id: string): TAdapter | undefined;
  detectAll(cwd?: string): Promise<TAdapter[]>;
};

export type EngineRegistries = {
  mcp: Registry<McpAdapter>;
  skills: Registry<SkillsAdapter>;
  rules: Registry<RulesAdapter>;
  agents: Registry<AgentsAdapter>;
  hooks: Registry<HooksAdapter>;
};

type RegistryModule<TAdapter extends DetectableAdapter> = {
  registry: Registry<TAdapter>;
};

async function loadRegistryModule<TAdapter extends DetectableAdapter>(
  packageName: string,
): Promise<RegistryModule<TAdapter>> {
  return import(packageName) as Promise<RegistryModule<TAdapter>>;
}

async function loadSideEffectModule(packageName: string): Promise<void> {
  await import(packageName);
}

export async function loadEngineRegistries(): Promise<EngineRegistries> {
  const adapterAllPackages = [
    "@itz4blitz/ai-tools-mcp/adapters/all",
    "@itz4blitz/ai-tools-skills/adapters/all",
    "@itz4blitz/ai-tools-rules/adapters/all",
    "@itz4blitz/ai-tools-agents/adapters/all",
    "@itz4blitz/ai-tools-hooks/adapters/all",
  ];

  await Promise.all(adapterAllPackages.map((pkg) => loadSideEffectModule(pkg)));

  const [mcp, skills, rules, agents, hooks] = await Promise.all([
    loadRegistryModule<McpAdapter>("@itz4blitz/ai-tools-mcp"),
    loadRegistryModule<SkillsAdapter>("@itz4blitz/ai-tools-skills"),
    loadRegistryModule<RulesAdapter>("@itz4blitz/ai-tools-rules"),
    loadRegistryModule<AgentsAdapter>("@itz4blitz/ai-tools-agents"),
    loadRegistryModule<HooksAdapter>("@itz4blitz/ai-tools-hooks"),
  ]);

  return {
    mcp: mcp.registry,
    skills: skills.registry,
    rules: rules.registry,
    agents: agents.registry,
    hooks: hooks.registry,
  };
}

export function getAllPluginEngines(): PluginEngine[] {
  return ["mcp", "skills", "rules", "agents", "hooks"];
}
