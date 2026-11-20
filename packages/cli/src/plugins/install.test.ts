import { beforeEach, describe, expect, it, vi } from "vitest";

const buildPluginInstallPlan = vi.fn();
const loadEngineRegistries = vi.fn();

vi.mock("./plan.js", () => ({
  buildPluginInstallPlan,
}));

vi.mock("./runtime.js", () => ({
  loadEngineRegistries,
}));

const plugin = {
  id: "release-confidence",
  name: "Release Confidence",
  version: "0.1.0",
  mcpServers: [{ id: "api", name: "API", transport: { type: "stdio", command: "api-mcp" } }],
  skills: [{ id: "tdd", name: "TDD", content: "Test first." }],
  hooks: [
    { id: "audit", name: "Audit", events: ["prompt:submit"], phase: "before", handler: vi.fn() },
  ],
};

const readyTarget = {
  toolId: "codex",
  toolName: "Codex",
  detected: true,
  selected: true,
  installable: true,
  host: {
    id: "codex",
    name: "Codex",
    kind: "cli",
    nativeEngineSupport: {},
    supportsInteractiveApps: false,
    supportsNativeBundles: false,
    notes: "Codex host",
  },
  engines: [
    {
      engine: "mcp",
      requested: true,
      nativeHostSupport: true,
      adapterAvailable: true,
      detected: true,
      status: "ready",
    },
    {
      engine: "skills",
      requested: true,
      nativeHostSupport: true,
      adapterAvailable: true,
      detected: true,
      status: "ready",
    },
    {
      engine: "rules",
      requested: false,
      nativeHostSupport: true,
      adapterAvailable: true,
      detected: true,
      status: "not-requested",
    },
  ],
};

const plan = {
  plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
  requestedEngines: ["mcp", "skills"],
  targets: [readyTarget],
};

function adapter(files: { path: string; content: string; format: string }[], fail = false) {
  return {
    id: "codex",
    detect: vi.fn(),
    generate: vi.fn().mockResolvedValue(files),
    install: fail
      ? vi.fn().mockRejectedValue(new Error("install failed"))
      : vi.fn().mockResolvedValue(undefined),
  };
}

describe("installPluginBundle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildPluginInstallPlan.mockResolvedValue(plan);
  });

  it("returns the plan without installing files in dry-run mode", async () => {
    const mcpAdapter = adapter([{ path: ".codex/mcp.json", content: "{}", format: "json" }]);
    loadEngineRegistries.mockResolvedValue({
      mcp: { get: () => mcpAdapter },
      skills: { get: () => undefined },
      rules: { get: () => undefined },
      agents: { get: () => undefined },
      hooks: { get: () => undefined },
    });
    const { installPluginBundle } = await import("./install.js");

    const result = await installPluginBundle(plugin, { dryRun: true, tools: ["codex"] });

    expect(result).toEqual({ plan, installed: [], failed: [] });
    expect(mcpAdapter.generate).not.toHaveBeenCalled();
  });

  it("installs ready engines and de-duplicates generated paths", async () => {
    const mcpAdapter = adapter([
      { path: ".codex/mcp.json", content: "{}", format: "json" },
      { path: ".codex/mcp.json", content: "{}", format: "json" },
    ]);
    const skillsAdapter = adapter([
      { path: ".codex/skills/tdd/SKILL.md", content: "Test first.", format: "md" },
    ]);
    loadEngineRegistries.mockResolvedValue({
      mcp: { get: () => mcpAdapter },
      skills: { get: () => skillsAdapter },
      rules: { get: () => undefined },
      agents: { get: () => undefined },
      hooks: { get: () => undefined },
    });
    const { installPluginBundle } = await import("./install.js");

    const result = await installPluginBundle(plugin, { tools: ["codex"], force: true });

    expect(result.failed).toEqual([]);
    expect(result.installed).toEqual([
      {
        toolId: "codex",
        toolName: "Codex",
        engine: "mcp",
        filePaths: [".codex/mcp.json"],
      },
      {
        toolId: "codex",
        toolName: "Codex",
        engine: "skills",
        filePaths: [".codex/skills/tdd/SKILL.md"],
      },
    ]);
  });

  it("installs only project-layer MCP servers whose whenPathContains matches cwd", async () => {
    const mcpAdapter = adapter([{ path: ".codex/mcp.json", content: "{}", format: "json" }]);
    loadEngineRegistries.mockResolvedValue({
      mcp: { get: () => mcpAdapter },
      skills: { get: () => undefined },
      rules: { get: () => undefined },
      agents: { get: () => undefined },
      hooks: { get: () => undefined },
    });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace/Development/OtherOrg/web");
    const { installPluginBundle } = await import("./install.js");

    const result = await installPluginBundle(
      {
        ...plugin,
        mcpServers: [
          {
            id: "github",
            name: "GitHub",
            transport: { type: "stdio", command: "gh-mcp" },
          },
          {
            id: "acme",
            name: "Acme",
            transport: { type: "stdio", command: "acme-mcp" },
            layer: "project",
            whenPathContains: ["AcmeCorp"],
          },
          {
            id: "unifi",
            name: "UniFi",
            transport: { type: "stdio", command: "unifi-mcp" },
            layer: "user",
          },
        ],
      },
      { tools: ["codex"] },
    );

    cwdSpy.mockRestore();
    expect(mcpAdapter.generate).toHaveBeenCalledWith([expect.objectContaining({ id: "github" })]);
    expect(mcpAdapter.generate.mock.calls[0]?.[0]).toHaveLength(1);
    expect(result.installed).toHaveLength(1);
  });

  it("installs path-gated servers only when cwd contains a required path fragment", async () => {
    const mcpAdapter = adapter([{ path: ".codex/mcp.json", content: "{}", format: "json" }]);
    loadEngineRegistries.mockResolvedValue({
      mcp: { get: () => mcpAdapter },
      skills: { get: () => undefined },
      rules: { get: () => undefined },
      agents: { get: () => undefined },
      hooks: { get: () => undefined },
    });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace/Development/AcmeCorp/app");
    const { installPluginBundle } = await import("./install.js");

    await installPluginBundle(
      {
        ...plugin,
        mcpServers: [
          {
            id: "acme",
            name: "Acme",
            transport: { type: "stdio", command: "acme-mcp" },
            layer: "project",
            whenPathContains: ["AcmeCorp", "acmecorp"],
          },
        ],
      },
      { tools: ["codex"] },
    );

    cwdSpy.mockRestore();
    expect(mcpAdapter.generate).toHaveBeenCalledWith([expect.objectContaining({ id: "acme" })]);
  });

  it("skips MCP install instead of writing an empty config when every server is filtered out", async () => {
    const mcpAdapter = adapter([{ path: ".codex/mcp.json", content: "{}", format: "json" }]);
    loadEngineRegistries.mockResolvedValue({
      mcp: { get: () => mcpAdapter },
      skills: { get: () => undefined },
      rules: { get: () => undefined },
      agents: { get: () => undefined },
      hooks: { get: () => undefined },
    });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace/Development/OtherOrg/web");
    const { installPluginBundle } = await import("./install.js");

    const result = await installPluginBundle(
      {
        ...plugin,
        mcpServers: [
          {
            id: "acme",
            name: "Acme",
            transport: { type: "stdio", command: "acme-mcp" },
            layer: "project",
            whenPathContains: ["AcmeCorp"],
          },
        ],
      },
      { tools: ["codex"] },
    );

    cwdSpy.mockRestore();
    expect(mcpAdapter.generate).not.toHaveBeenCalled();
    expect(mcpAdapter.install).not.toHaveBeenCalled();
    expect(result.installed).toEqual([]);
  });

  it("installs rules, agents, and hooks when those engines are ready", async () => {
    const rulesAdapter = adapter([{ path: ".codex/rules.md", content: "tdd", format: "md" }]);
    const agentsAdapter = adapter([{ path: ".codex/agents/qa.md", content: "qa", format: "md" }]);
    const hooksAdapter = adapter([{ path: ".codex/hooks.json", content: "{}", format: "json" }]);
    buildPluginInstallPlan.mockResolvedValue({
      ...plan,
      requestedEngines: ["rules", "agents", "hooks"],
      targets: [
        {
          ...readyTarget,
          engines: [
            {
              engine: "rules",
              requested: true,
              nativeHostSupport: true,
              adapterAvailable: true,
              detected: true,
              status: "ready",
            },
            {
              engine: "agents",
              requested: true,
              nativeHostSupport: true,
              adapterAvailable: true,
              detected: true,
              status: "ready",
            },
            {
              engine: "hooks",
              requested: true,
              nativeHostSupport: true,
              adapterAvailable: true,
              detected: true,
              status: "ready",
            },
          ],
        },
      ],
    });
    loadEngineRegistries.mockResolvedValue({
      mcp: { get: () => undefined },
      skills: { get: () => undefined },
      rules: { get: () => rulesAdapter },
      agents: { get: () => agentsAdapter },
      hooks: { get: () => hooksAdapter },
    });
    const { installPluginBundle } = await import("./install.js");

    const result = await installPluginBundle({
      ...plugin,
      rules: [{ id: "tdd", name: "TDD", content: "Test first.", scope: { type: "always" } }],
      agents: [{ id: "qa", name: "QA", instructions: "Find gaps." }],
    });

    expect(result.failed).toEqual([]);
    expect(result.installed.map((item) => item.engine)).toEqual(["rules", "agents", "hooks"]);
    expect(rulesAdapter.generate).toHaveBeenCalled();
    expect(agentsAdapter.generate).toHaveBeenCalled();
    expect(hooksAdapter.generate).toHaveBeenCalled();
  });

  it("records a missing adapter for every engine", async () => {
    buildPluginInstallPlan.mockResolvedValue({
      ...plan,
      requestedEngines: ["mcp", "skills", "rules", "agents", "hooks"],
      targets: [
        {
          ...readyTarget,
          engines: ["mcp", "skills", "rules", "agents", "hooks"].map((engine) => ({
            engine,
            requested: true,
            nativeHostSupport: true,
            adapterAvailable: true,
            detected: true,
            status: "ready",
          })),
        },
      ],
    });
    loadEngineRegistries.mockResolvedValue({
      mcp: { get: () => undefined },
      skills: { get: () => undefined },
      rules: { get: () => undefined },
      agents: { get: () => undefined },
      hooks: { get: () => undefined },
    });
    const { installPluginBundle } = await import("./install.js");

    const result = await installPluginBundle(plugin);

    expect(result.installed).toEqual([]);
    expect(result.failed.map((item) => item.error)).toEqual([
      "Missing MCP adapter for codex",
      "Missing skills adapter for codex",
      "Missing rules adapter for codex",
      "Missing agents adapter for codex",
      "Missing hooks adapter for codex",
    ]);
  });

  it("records missing adapters as failures without aborting later engines", async () => {
    const hooksAdapter = adapter([{ path: ".codex/hooks.json", content: "{}", format: "json" }]);
    buildPluginInstallPlan.mockResolvedValue({
      ...plan,
      requestedEngines: ["rules", "hooks"],
      targets: [
        {
          ...readyTarget,
          engines: [
            {
              engine: "rules",
              requested: true,
              nativeHostSupport: true,
              adapterAvailable: true,
              detected: true,
              status: "ready",
            },
            {
              engine: "hooks",
              requested: true,
              nativeHostSupport: true,
              adapterAvailable: true,
              detected: true,
              status: "ready",
            },
          ],
        },
      ],
    });
    loadEngineRegistries.mockResolvedValue({
      mcp: { get: () => undefined },
      skills: { get: () => undefined },
      rules: { get: () => undefined },
      agents: { get: () => undefined },
      hooks: { get: () => hooksAdapter },
    });
    const { installPluginBundle } = await import("./install.js");

    const result = await installPluginBundle(plugin);

    expect(result.failed).toEqual([
      {
        toolId: "codex",
        toolName: "Codex",
        engine: "rules",
        error: "Missing rules adapter for codex",
      },
    ]);
    expect(result.installed).toEqual([
      {
        toolId: "codex",
        toolName: "Codex",
        engine: "hooks",
        filePaths: [".codex/hooks.json"],
      },
    ]);
  });

  it("stringifies non-Error install failures", async () => {
    const mcpAdapter = {
      id: "codex",
      detect: vi.fn(),
      generate: vi
        .fn()
        .mockResolvedValue([{ path: ".codex/mcp.json", content: "{}", format: "json" }]),
      install: vi.fn().mockRejectedValue("disk full"),
    };
    loadEngineRegistries.mockResolvedValue({
      mcp: { get: () => mcpAdapter },
      skills: { get: () => undefined },
      rules: { get: () => undefined },
      agents: { get: () => undefined },
      hooks: { get: () => undefined },
    });
    const { installPluginBundle } = await import("./install.js");

    const result = await installPluginBundle(plugin);

    expect(result.failed).toContainEqual({
      toolId: "codex",
      toolName: "Codex",
      engine: "mcp",
      error: "disk full",
    });
  });

  it("records install failures without aborting the bundle", async () => {
    const mcpAdapter = adapter([{ path: ".codex/mcp.json", content: "{}", format: "json" }], true);
    const skillsAdapter = adapter([
      { path: ".codex/skills/tdd/SKILL.md", content: "Test first.", format: "md" },
    ]);
    loadEngineRegistries.mockResolvedValue({
      mcp: { get: () => mcpAdapter },
      skills: { get: () => skillsAdapter },
      rules: { get: () => undefined },
      agents: { get: () => undefined },
      hooks: { get: () => undefined },
    });
    const { installPluginBundle } = await import("./install.js");

    const result = await installPluginBundle(plugin);

    expect(result.installed).toHaveLength(1);
    expect(result.failed).toEqual([
      {
        toolId: "codex",
        toolName: "Codex",
        engine: "mcp",
        error: "install failed",
      },
    ]);
  });
});
