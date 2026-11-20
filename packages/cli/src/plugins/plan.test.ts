import { describe, expect, it, vi } from "vitest";

const mockRegistries = {
  mcp: {
    list: () => ["cursor", "codex", "claude-desktop", "opencode", "claude-code"],
    get: () => undefined,
    detectAll: async () => [{ id: "cursor" }, { id: "codex" }, { id: "claude-desktop" }],
  },
  skills: {
    list: () => ["cursor", "codex", "opencode", "claude-code"],
    get: () => undefined,
    detectAll: async () => [{ id: "cursor" }, { id: "codex" }],
  },
  rules: {
    list: () => ["cursor", "codex", "opencode", "claude-code"],
    get: () => undefined,
    detectAll: async () => [{ id: "cursor" }, { id: "codex" }],
  },
  agents: {
    list: () => ["cursor", "codex", "opencode", "claude-code"],
    get: () => undefined,
    detectAll: async () => [{ id: "cursor" }, { id: "codex" }],
  },
  hooks: {
    list: () => ["cursor", "codex", "opencode", "claude-code"],
    get: () => undefined,
    detectAll: async () => [{ id: "cursor" }, { id: "codex" }],
  },
};

vi.mock("./runtime.js", () => ({
  loadEngineRegistries: async () => mockRegistries,
  getAllPluginEngines: () => ["mcp", "skills", "rules", "agents", "hooks"],
}));

import { buildPluginInstallPlan } from "./plan.js";

describe("buildPluginInstallPlan", () => {
  it("marks Cursor as ready for MCP and skills", async () => {
    const plan = await buildPluginInstallPlan(
      {
        id: "cert-coach",
        name: "Certification Coach",
        version: "0.1.0",
        mcpServers: [
          {
            id: "cert-coach",
            name: "Certification Coach",
            transport: { type: "stdio", command: "npx", args: ["cert-coach-mcp"] },
          },
        ],
        skills: [
          {
            id: "study-start",
            name: "Study Start",
            content: "Start a study session.",
          },
        ],
      },
      {
        tools: ["cursor"],
        force: true,
        detectedToolsOverride: ["cursor"],
      },
    );

    const cursor = plan.targets[0];
    expect(cursor?.toolId).toBe("cursor");
    expect(cursor?.installable).toBe(true);
    expect(cursor?.engines.find((item) => item.engine === "mcp")?.status).toBe("ready");
    expect(cursor?.engines.find((item) => item.engine === "skills")?.status).toBe("ready");
  });

  it("marks Claude Desktop as host-unsupported for skills", async () => {
    const plan = await buildPluginInstallPlan(
      {
        id: "cert-coach",
        name: "Certification Coach",
        version: "0.1.0",
        skills: [
          {
            id: "study-start",
            name: "Study Start",
            content: "Start a study session.",
          },
        ],
      },
      {
        tools: ["claude-desktop"],
        force: true,
        detectedToolsOverride: ["claude-desktop"],
      },
    );

    const target = plan.targets[0];
    expect(target?.engines.find((item) => item.engine === "skills")?.status).toBe(
      "host-unsupported",
    );
  });

  it("marks Codex hooks as ready once the adapter exists", async () => {
    const plan = await buildPluginInstallPlan(
      {
        id: "cert-coach",
        name: "Certification Coach",
        version: "0.1.0",
        hooks: [
          {
            id: "audit",
            name: "Audit",
            description: "Audit prompts",
            events: ["prompt:submit"],
            priority: 1,
            phase: "before",
            enabled: true,
            handler: async () => {},
          },
        ],
      },
      {
        tools: ["codex"],
        force: true,
        detectedToolsOverride: ["codex"],
      },
    );

    const target = plan.targets[0];
    expect(target?.engines.find((item) => item.engine === "hooks")?.status).toBe("ready");
  });

  it("marks Codex agents as ready once the adapter exists", async () => {
    const plan = await buildPluginInstallPlan(
      {
        id: "cert-coach",
        name: "Certification Coach",
        version: "0.1.0",
        agents: [
          {
            id: "reviewer",
            name: "Reviewer",
            instructions: "Review correctness and missing tests.",
          },
        ],
      },
      {
        tools: ["codex"],
        force: true,
        detectedToolsOverride: ["codex"],
      },
    );

    const target = plan.targets[0];
    expect(target?.engines.find((item) => item.engine === "agents")?.status).toBe("ready");
  });

  it("marks zcode hooks as adapter-missing until the hooks registry lists zcode", async () => {
    const plan = await buildPluginInstallPlan(
      {
        id: "cert-coach",
        name: "Certification Coach",
        version: "0.1.0",
        hooks: [
          {
            id: "audit",
            name: "Audit",
            events: ["prompt:submit"],
            phase: "before",
            handler: async () => {},
          },
        ],
      },
      {
        tools: ["zcode"],
        force: true,
        detectedToolsOverride: ["zcode"],
      },
    );

    expect(plan.targets[0]?.host.nativeEngineSupport.hooks).toBe(true);
    expect(plan.targets[0]?.engines.find((item) => item.engine === "hooks")?.status).toBe(
      "adapter-missing",
    );
  });

  it("marks antigravity-cli MCP as host-unsupported because no MCP adapter exists", async () => {
    const plan = await buildPluginInstallPlan(
      {
        id: "cert-coach",
        name: "Certification Coach",
        version: "0.1.0",
        mcpServers: [
          {
            id: "cert-coach",
            name: "Certification Coach",
            transport: { type: "stdio", command: "npx" },
          },
        ],
      },
      {
        tools: ["antigravity-cli"],
        force: true,
        detectedToolsOverride: ["antigravity-cli"],
      },
    );

    expect(plan.targets[0]?.engines.find((item) => item.engine === "mcp")?.status).toBe(
      "host-unsupported",
    );
  });

  it("reports amp hooks as supported on the host and agents as host-unsupported", async () => {
    const plan = await buildPluginInstallPlan(
      {
        id: "cert-coach",
        name: "Certification Coach",
        version: "0.1.0",
        hooks: [
          {
            id: "audit",
            name: "Audit",
            events: ["tool:before"],
            phase: "before",
            handler: async () => {},
          },
        ],
        agents: [
          {
            id: "reviewer",
            name: "Reviewer",
            instructions: "Review code.",
          },
        ],
      },
      {
        tools: ["amp"],
        force: true,
        detectedToolsOverride: ["amp"],
      },
    );

    expect(plan.targets[0]?.host.nativeEngineSupport.hooks).toBe(true);
    expect(plan.targets[0]?.host.supportsNativeBundles).toBe(true);
    expect(plan.targets[0]?.engines.find((item) => item.engine === "agents")?.status).toBe(
      "host-unsupported",
    );
  });
});
