import { beforeEach, describe, expect, it, vi } from "vitest";

const buildPluginInstallPlan = vi.fn();
const installPluginBundle = vi.fn();
const loadPluginConfig = vi.fn();

vi.mock("./hosts.js", () => ({
  KNOWN_PLUGIN_HOSTS: {
    codex: {
      id: "codex",
      name: "Codex",
      kind: "cli",
      nativeEngineSupport: {},
      supportsInteractiveApps: false,
      supportsNativeBundles: false,
      notes: "Codex host",
    },
    opencode: {
      id: "opencode",
      name: "OpenCode",
      kind: "cli",
      nativeEngineSupport: {},
      supportsInteractiveApps: false,
      supportsNativeBundles: false,
      notes: "OpenCode host",
    },
  },
}));

vi.mock("./install.js", () => ({
  installPluginBundle,
}));

vi.mock("./load-config.js", () => ({
  loadPluginConfig,
}));

vi.mock("./plan.js", () => ({
  buildPluginInstallPlan,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

const plugin = {
  id: "release-confidence",
  name: "Release Confidence",
  version: "0.1.0",
  description: "Testing and QA bundle.",
  skills: [{ id: "test-slice", name: "Test Slice", content: "Write the test first." }],
};

const plan = {
  plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
  requestedEngines: ["skills"],
  targets: [
    {
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
          engine: "skills",
          requested: true,
          nativeHostSupport: true,
          adapterAvailable: true,
          detected: true,
          status: "ready",
        },
      ],
    },
  ],
};

describe("plugins CLI", () => {
  const logs: string[] = [];
  const errors: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    logs.length = 0;
    errors.length = 0;
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });
    vi.spyOn(console, "error").mockImplementation((message = "") => {
      errors.push(String(message));
    });
    loadPluginConfig.mockResolvedValue(plugin);
    buildPluginInstallPlan.mockResolvedValue(plan);
    installPluginBundle.mockResolvedValue({ plan, installed: [], failed: [] });
  });

  it("prints help when no command is provided", async () => {
    const { run } = await import("./cli.js");

    await run([]);

    expect(logs.join("\n")).toContain("ai-tools plugins");
  });

  it("plans selected tools from flags", async () => {
    const { run } = await import("./cli.js");

    await run(["plan", "--config=plugin.config.ts", "--tools=codex, opencode", "--force"]);

    expect(loadPluginConfig).toHaveBeenCalledWith("plugin.config.ts");
    expect(buildPluginInstallPlan).toHaveBeenCalledWith(plugin, {
      tools: ["codex", "opencode"],
      force: true,
    });
    expect(logs.join("\n")).toContain("Release Confidence");
    expect(logs.join("\n")).toContain("Codex");
  });

  it("passes dry-run installs through without writing artifacts", async () => {
    const { run } = await import("./cli.js");

    await run(["install", "--tools=codex", "--dry-run"]);

    expect(installPluginBundle).toHaveBeenCalledWith(plugin, {
      tools: ["codex"],
      force: undefined,
      dryRun: true,
      layer: undefined,
    });
    expect(logs.join("\n")).toContain("[dry-run] No files were written.");
  });

  it("passes --layer=user to installPluginBundle", async () => {
    const { run } = await import("./cli.js");

    await run(["install", "--tools=codex", "--layer=user"]);

    expect(installPluginBundle).toHaveBeenCalledWith(plugin, {
      tools: ["codex"],
      force: undefined,
      dryRun: undefined,
      layer: "user",
    });
  });

  it("rejects invalid --layer values", async () => {
    const { run } = await import("./cli.js");

    await expect(run(["install", "--layer=global"])).rejects.toThrow('Invalid --layer "global"');
  });

  it("prints installed artifacts and failures and exits with code 1", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    installPluginBundle.mockResolvedValue({
      plan,
      installed: [
        {
          toolId: "codex",
          toolName: "Codex",
          engine: "skills",
          filePaths: [".codex/skills/release-confidence/SKILL.md"],
        },
      ],
      failed: [
        {
          toolId: "opencode",
          toolName: "OpenCode",
          engine: "hooks",
          error: "missing adapter",
        },
      ],
    });
    const { run } = await import("./cli.js");

    await expect(run(["install"])).rejects.toThrow("process.exit(1)");
    exitSpy.mockRestore();

    const output = logs.join("\n");
    expect(output).toContain("Installed artifacts:");
    expect(output).toContain(".codex/skills/release-confidence/SKILL.md");
    expect(output).toContain("Failures:");
    expect(output).toContain("missing adapter");
  });

  it("detects known portable hosts", async () => {
    const { run } = await import("./cli.js");

    await run(["detect"]);

    expect(buildPluginInstallPlan).toHaveBeenCalledWith(
      { id: "detect-only", name: "Detect Only", version: "0.0.0" },
      { tools: ["codex", "opencode"], force: true },
    );
    expect(logs.join("\n")).toContain("Known portable hosts");
  });
});
