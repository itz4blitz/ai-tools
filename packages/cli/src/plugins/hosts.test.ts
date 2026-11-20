import { describe, expect, it } from "vitest";
import { getPluginHostInfo, KNOWN_PLUGIN_HOSTS } from "./hosts.js";
import type { PluginEngine } from "./types.js";

const ENGINES: PluginEngine[] = ["mcp", "skills", "rules", "agents", "hooks"];

/** Adapter files that actually exist under packages/<engine>/src/adapters. */
const ADAPTER_SUPPORT: Record<string, Record<PluginEngine, boolean>> = {
  "claude-code": { mcp: true, skills: true, rules: true, agents: true, hooks: true },
  "claude-desktop": { mcp: true, skills: false, rules: false, agents: false, hooks: false },
  codex: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
  cursor: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
  opencode: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
  grok: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
  zcode: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
  "antigravity-cli": { mcp: true, skills: true, rules: true, agents: true, hooks: true },
  windsurf: { mcp: true, skills: true, rules: true, agents: false, hooks: false },
  copilot: { mcp: true, skills: true, rules: true, agents: true, hooks: false },
  kiro: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
  cline: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
  droid: { mcp: true, skills: true, rules: true, agents: true, hooks: true },
  amp: { mcp: true, skills: true, rules: true, agents: false, hooks: false },
  continue: { mcp: false, skills: true, rules: true, agents: false, hooks: false },
  "gemini-cli": { mcp: true, skills: true, rules: true, agents: true, hooks: true },
  "roo-code": { mcp: true, skills: true, rules: true, agents: true, hooks: false },
};

describe("KNOWN_PLUGIN_HOSTS", () => {
  it("lists every adapter-backed host", () => {
    expect(Object.keys(KNOWN_PLUGIN_HOSTS).toSorted()).toEqual(
      Object.keys(ADAPTER_SUPPORT).toSorted(),
    );
  });

  it("sets nativeEngineSupport to match real adapters, not wishful flags", () => {
    for (const [id, expected] of Object.entries(ADAPTER_SUPPORT)) {
      const host = KNOWN_PLUGIN_HOSTS[id];
      expect(host, `missing host ${id}`).toBeDefined();
      expect(host?.nativeEngineSupport).toEqual(expected);
    }
  });

  it("claims antigravity-cli MCP and hooks because both adapters exist", () => {
    expect(KNOWN_PLUGIN_HOSTS["antigravity-cli"]?.nativeEngineSupport.mcp).toBe(true);
    expect(KNOWN_PLUGIN_HOSTS["antigravity-cli"]?.nativeEngineSupport.hooks).toBe(true);
  });

  it("claims zcode hooks because packages/hooks registers a zcode adapter", () => {
    expect(KNOWN_PLUGIN_HOSTS.zcode?.nativeEngineSupport.hooks).toBe(true);
  });

  it("fills every PluginEngine key on each host", () => {
    for (const host of Object.values(KNOWN_PLUGIN_HOSTS)) {
      for (const engine of ENGINES) {
        expect(typeof host.nativeEngineSupport[engine]).toBe("boolean");
      }
    }
  });
});

describe("getPluginHostInfo", () => {
  it("returns researched metadata for known hosts", () => {
    expect(getPluginHostInfo("grok").name).toBe("Grok");
    expect(getPluginHostInfo("droid").nativeEngineSupport.hooks).toBe(true);
  });

  it("returns all-false support for unknown hosts instead of inventing adapters", () => {
    const host = getPluginHostInfo("not-a-real-tool");
    expect(host).toEqual({
      id: "not-a-real-tool",
      name: "not-a-real-tool",
      kind: "cli",
      nativeEngineSupport: { mcp: false, skills: false, rules: false, agents: false, hooks: false },
      supportsInteractiveApps: false,
      supportsNativeBundles: false,
      notes: "No researched host metadata is available for this tool yet.",
    });
  });
});
