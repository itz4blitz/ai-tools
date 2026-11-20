export type PluginMCPTransport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> };

export type PluginMCPServerDefinition = {
  id: string;
  name: string;
  description?: string;
  transport: PluginMCPTransport;
  enabled?: boolean;
  tags?: string[];
  layer?: "user" | "project";
  whenPathContains?: string[];
};

export type PluginSkillDefinition = {
  id: string;
  name: string;
  description?: string;
  content: string;
  tags?: string[];
  enabled?: boolean;
};

export type PluginRuleScope =
  | { type: "always" }
  | { type: "glob"; patterns: string[] }
  | { type: "manual" }
  | { type: "agent"; agentId: string };

export type PluginRuleDefinition = {
  id: string;
  name: string;
  description?: string;
  content: string;
  scope: PluginRuleScope;
  priority?: number;
  tags?: string[];
  enabled?: boolean;
};

export type PluginAgentDefinition = {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  model?: string;
  tools?: string[];
  tags?: string[];
  enabled?: boolean;
};

export type PluginHookEventType =
  | "session:start"
  | "session:end"
  | "prompt:submit"
  | "prompt:response"
  | "tool:before"
  | "tool:after"
  | "file:read"
  | "file:write"
  | "file:edit"
  | "file:delete"
  | "shell:before"
  | "shell:after"
  | "mcp:before"
  | "mcp:after"
  | "notification";

export type PluginHookDefinition = {
  id: string;
  name: string;
  description?: string;
  events: PluginHookEventType[];
  handler: (ctx: unknown, next: () => Promise<void>) => Promise<void> | void;
  priority?: number;
  phase: "before" | "after";
  filter?: (event: unknown) => boolean;
  enabled?: boolean;
};

export type PluginEngine = "mcp" | "skills" | "rules" | "agents" | "hooks";

export type PluginToolId = string;

export type PluginTargetSelection = {
  include?: PluginToolId[];
  exclude?: PluginToolId[];
};

export type AiPluginDefinition = {
  id: string;
  name: string;
  version: string;
  description?: string;
  targets?: PluginTargetSelection;
  mcpServers?: PluginMCPServerDefinition[];
  skills?: PluginSkillDefinition[];
  rules?: PluginRuleDefinition[];
  agents?: PluginAgentDefinition[];
  hooks?: PluginHookDefinition[];
};

export type PluginHostKind = "desktop" | "cli" | "hybrid";

export type PluginHostInfo = {
  id: PluginToolId;
  name: string;
  kind: PluginHostKind;
  nativeEngineSupport: Record<PluginEngine, boolean>;
  supportsInteractiveApps: boolean;
  supportsNativeBundles: boolean;
  notes: string;
};

export type EnginePlanStatus =
  | "ready"
  | "not-requested"
  | "host-unsupported"
  | "adapter-missing"
  | "not-detected";

export type EngineInstallPlan = {
  engine: PluginEngine;
  requested: boolean;
  nativeHostSupport: boolean;
  adapterAvailable: boolean;
  detected: boolean;
  status: EnginePlanStatus;
};

export type PluginTargetPlan = {
  toolId: PluginToolId;
  toolName: string;
  detected: boolean;
  selected: boolean;
  installable: boolean;
  host: PluginHostInfo;
  engines: EngineInstallPlan[];
};

export type PluginInstallPlan = {
  plugin: Pick<AiPluginDefinition, "id" | "name" | "version">;
  requestedEngines: PluginEngine[];
  targets: PluginTargetPlan[];
};

export type BuildPluginPlanOptions = {
  tools?: PluginToolId[];
  force?: boolean;
  detectedToolsOverride?: PluginToolId[];
};

export type InstalledPluginArtifact = {
  toolId: PluginToolId;
  toolName: string;
  engine: PluginEngine;
  filePaths: string[];
};

export type FailedPluginArtifact = {
  toolId: PluginToolId;
  toolName: string;
  engine: PluginEngine;
  error: string;
};

export type InstallPluginOptions = BuildPluginPlanOptions & {
  dryRun?: boolean;
  layer?: "project" | "user";
};

export type InstallPluginResult = {
  plan: PluginInstallPlan;
  installed: InstalledPluginArtifact[];
  failed: FailedPluginArtifact[];
};
