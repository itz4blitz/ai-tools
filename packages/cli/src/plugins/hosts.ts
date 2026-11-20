import type { PluginEngine, PluginHostInfo, PluginToolId } from "./types.js";

const NO_ENGINES: Record<PluginEngine, boolean> = {
  mcp: false,
  skills: false,
  rules: false,
  agents: false,
  hooks: false,
};

export const KNOWN_PLUGIN_HOSTS: Record<string, PluginHostInfo> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    kind: "cli",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
    supportsInteractiveApps: false,
    supportsNativeBundles: false,
    notes: "Claude Code exposes MCP plus project-level hooks, agents, commands, and rules.",
  },
  "claude-desktop": {
    id: "claude-desktop",
    name: "Claude Desktop",
    kind: "desktop",
    nativeEngineSupport: { mcp: true, skills: false, rules: false, agents: false, hooks: false },
    supportsInteractiveApps: true,
    supportsNativeBundles: true,
    notes:
      "Claude Desktop installs local MCP desktop extensions and can render interactive remote connectors, but it is not a general skills or hooks host.",
  },
  codex: {
    id: "codex",
    name: "Codex",
    kind: "hybrid",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
    supportsInteractiveApps: false,
    supportsNativeBundles: true,
    notes:
      "Codex plugins bundle skills, MCP, hooks, app integrations, and project or user custom agents across the CLI, app, and IDE extension.",
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    kind: "desktop",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
    supportsInteractiveApps: true,
    supportsNativeBundles: true,
    notes:
      "Cursor plugins can bundle rules, skills, agents, commands, MCP servers, and hooks, and Cursor supports MCP Apps for interactive UI.",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    kind: "hybrid",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
    supportsInteractiveApps: false,
    supportsNativeBundles: true,
    notes:
      "OpenCode ships as a terminal app, desktop app, and IDE extension with first-class MCP support plus a native plugin system.",
  },
  grok: {
    id: "grok",
    name: "Grok",
    kind: "cli",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
    supportsInteractiveApps: false,
    supportsNativeBundles: true,
    notes:
      "Grok reads project `.grok/config.toml` and user `~/.grok/config.toml`. MCP lives under [mcp_servers]. PalamHealth servers must be project-layer.",
  },
  zcode: {
    id: "zcode",
    name: "ZCode",
    kind: "cli",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
    supportsInteractiveApps: false,
    supportsNativeBundles: false,
    notes:
      "ZCode user MCP is ~/.zcode/cli/config.json (mcp.servers). Project MCP is .zcode/mcp.json. Hooks live in .zcode/config.json and .zcode/hooks.json. Do not put PalamHealth in the user file.",
  },
  "antigravity-cli": {
    id: "antigravity-cli",
    name: "Antigravity CLI",
    kind: "hybrid",
    nativeEngineSupport: { mcp: false, skills: true, rules: true, agents: true, hooks: false },
    supportsInteractiveApps: true,
    supportsNativeBundles: true,
    notes:
      "Antigravity CLI adapters cover workspace .agents skills, agents, and rules. There is no MCP or hooks adapter.",
  },
  windsurf: {
    id: "windsurf",
    name: "Windsurf",
    kind: "desktop",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: false, hooks: false },
    supportsInteractiveApps: false,
    supportsNativeBundles: false,
    notes:
      "Windsurf can consume MCP, prompts, and rules, but ai-tools does not yet model a richer native bundle surface.",
  },
  copilot: {
    id: "copilot",
    name: "VS Code / Copilot",
    kind: "desktop",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: true, hooks: false },
    supportsInteractiveApps: false,
    supportsNativeBundles: false,
    notes:
      "Copilot can consume MCP and prompt surfaces through the IDE, but ai-tools currently treats it as direct engine deployment.",
  },
  kiro: {
    id: "kiro",
    name: "Kiro",
    kind: "desktop",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
    supportsInteractiveApps: false,
    supportsNativeBundles: false,
    notes: "Kiro exposes multiple config surfaces that ai-tools can target directly.",
  },
  cline: {
    id: "cline",
    name: "Cline",
    kind: "hybrid",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
    supportsInteractiveApps: false,
    supportsNativeBundles: false,
    notes:
      "Cline runs as both a VS Code extension and CLI, using .clinerules/ (rules, hooks, workflows), .cline/skills/, and OS-specific cline_mcp_settings.json.",
  },
  droid: {
    id: "droid",
    name: "Factory Droid",
    kind: "cli",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
    supportsInteractiveApps: false,
    supportsNativeBundles: false,
    notes:
      "Factory Droid adapters write .factory configs for hooks, MCP, agents, skills, and rules.",
  },
  amp: {
    id: "amp",
    name: "Amp",
    kind: "cli",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: false, hooks: false },
    supportsInteractiveApps: false,
    supportsNativeBundles: false,
    notes: "Amp adapters cover MCP, skills, and rules. There is no agents or hooks adapter.",
  },
  continue: {
    id: "continue",
    name: "Continue",
    kind: "desktop",
    nativeEngineSupport: { mcp: false, skills: true, rules: true, agents: false, hooks: false },
    supportsInteractiveApps: false,
    supportsNativeBundles: false,
    notes: "Continue adapters cover skills and rules only.",
  },
  "gemini-cli": {
    id: "gemini-cli",
    name: "Gemini CLI",
    kind: "cli",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
    supportsInteractiveApps: false,
    supportsNativeBundles: false,
    notes: "Gemini CLI adapters cover hooks, MCP, agents, skills, and rules.",
  },
  "roo-code": {
    id: "roo-code",
    name: "Roo Code",
    kind: "desktop",
    nativeEngineSupport: { mcp: true, skills: true, rules: true, agents: true, hooks: false },
    supportsInteractiveApps: false,
    supportsNativeBundles: false,
    notes: "Roo Code adapters cover MCP, agents, skills, and rules. There is no hooks adapter.",
  },
};

export function getPluginHostInfo(id: PluginToolId): PluginHostInfo {
  return (
    KNOWN_PLUGIN_HOSTS[id] ?? {
      id,
      name: id,
      kind: "cli",
      nativeEngineSupport: { ...NO_ENGINES },
      supportsInteractiveApps: false,
      supportsNativeBundles: false,
      notes: "No researched host metadata is available for this tool yet.",
    }
  );
}
