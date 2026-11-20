import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Adapter, AiHooksConfig, HookDefinition, GeneratedConfig } from "../index.js";

// ── Hoisted mocks (available inside vi.mock factories) ──────────

const {
  mockLoadConfig,
  mockFindConfigFile,
  mockRegistryDetectAll,
  mockRegistryList,
  mockRegistryGet,
  mockGetHooks,
  mockWriteFile,
  mockMkdir,
} = vi.hoisted(() => ({
  mockLoadConfig: vi.fn(),
  mockFindConfigFile: vi.fn(),
  mockRegistryDetectAll: vi.fn(),
  mockRegistryList: vi.fn(),
  mockRegistryGet: vi.fn(),
  mockGetHooks: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
}));

// ── Mock all adapter self-registration (side-effect import) ─────

vi.mock("../adapters/all.js", () => ({}));

// ── Mock config module (used by cli/index.ts) ───────────────────

vi.mock("../config/index.js", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  findConfigFile: (...args: unknown[]) => mockFindConfigFile(...args),
}));

// ── Mock runtime module (used by cli/index.ts) ──────────────────

vi.mock("../runtime/index.js", () => {
  class StubHookEngine {
    getHooks(): HookDefinition[] {
      return mockGetHooks();
    }
  }

  return {
    HookEngine: StubHookEngine,
  };
});

// ── Mock adapter registry (used by cli/index.ts) ────────────────

vi.mock("../adapters/registry.js", () => ({
  registry: {
    detectAll: () => mockRegistryDetectAll(),
    list: () => mockRegistryList(),
    get: (id: string) => mockRegistryGet(id),
  },
}));

// ── Mock node:fs/promises (used by cmdInit + writeConfigs) ──────

vi.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

// ── Import under test (after mocks are set up) ─────────────────

import { run } from "./index.js";

// ── Mock adapter factory ────────────────────────────────────────

function makeAdapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    id: overrides.id ?? "test-tool",
    name: overrides.name ?? "Test Tool",
    version: overrides.version ?? "1.0.0",
    capabilities: overrides.capabilities ?? {
      beforeHooks: true,
      afterHooks: true,
      mcp: false,
      configFile: true,
      supportedEvents: ["shell:before", "shell:after"],
      blockableEvents: ["shell:before"],
    },
    detect: overrides.detect ?? vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    generate:
      overrides.generate ??
      vi
        .fn<(hooks: HookDefinition[]) => Promise<GeneratedConfig[]>>()
        .mockResolvedValue([{ path: ".test-tool/hooks.json", content: "{}", format: "json" }]),
    install:
      overrides.install ??
      vi.fn<(configs: GeneratedConfig[]) => Promise<void>>().mockResolvedValue(undefined),
    uninstall: overrides.uninstall ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    mapEvent: overrides.mapEvent ?? vi.fn<(event: string) => string[]>().mockReturnValue([]),
    mapNativeEvent:
      overrides.mapNativeEvent ?? vi.fn<(nativeEvent: string) => string[]>().mockReturnValue([]),
  } as Adapter;
}

// ── Console / process mocks ─────────────────────────────────────

let logOutput: string[];
let errorOutput: string[];
let warnOutput: string[];
let exitCode: number | undefined;

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalExit = process.exit;

beforeEach(() => {
  logOutput = [];
  errorOutput = [];
  warnOutput = [];
  exitCode = undefined;

  console.log = vi.fn((...args: unknown[]) => {
    logOutput.push(args.map(String).join(" "));
  });
  console.error = vi.fn((...args: unknown[]) => {
    errorOutput.push(args.map(String).join(" "));
  });
  console.warn = vi.fn((...args: unknown[]) => {
    warnOutput.push(args.map(String).join(" "));
  });
  process.exit = vi.fn((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as never;

  vi.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  process.exit = originalExit;
});

// ── Helpers ─────────────────────────────────────────────────────

function allLog(): string {
  return logOutput.join("\n");
}

function allError(): string {
  return errorOutput.join("\n");
}

function allWarn(): string {
  return warnOutput.join("\n");
}

// ── Tests ───────────────────────────────────────────────────────

describe("run() - help output", () => {
  it('prints help text for "help" command', async () => {
    await run(["help"]);
    expect(allLog()).toContain("ai-hooks - Universal hooks framework");
    expect(allLog()).toContain("USAGE:");
    expect(allLog()).toContain("COMMANDS:");
    expect(allLog()).toContain("OPTIONS:");
    expect(allLog()).toContain("EXAMPLES:");
  });

  it("prints help text for --help flag", async () => {
    await run(["--help"]);
    expect(allLog()).toContain("ai-hooks - Universal hooks framework");
  });

  it("prints help text for -h flag", async () => {
    await run(["-h"]);
    expect(allLog()).toContain("ai-hooks - Universal hooks framework");
  });

  it("prints help text when no arguments are provided", async () => {
    await run([]);
    expect(allLog()).toContain("ai-hooks - Universal hooks framework");
  });

  it("includes all documented commands in help text", async () => {
    await run(["help"]);
    const output = allLog();
    for (const cmd of [
      "init",
      "detect",
      "generate",
      "install",
      "uninstall",
      "list",
      "status",
      "help",
    ]) {
      expect(output).toContain(cmd);
    }
  });

  it("includes all documented options in help text", async () => {
    await run(["help"]);
    const output = allLog();
    for (const opt of ["--tools", "--config", "--verbose", "--dry-run"]) {
      expect(output).toContain(opt);
    }
  });
});

describe("run() - unknown command", () => {
  it("prints error and help, then exits with code 1", async () => {
    await expect(run(["foobar"])).rejects.toThrow("process.exit(1)");
    expect(allError()).toContain("Unknown command: foobar");
    expect(allLog()).toContain("USAGE:");
    expect(exitCode).toBe(1);
  });

  it("prints the actual command name in the error message", async () => {
    await expect(run(["deploy-everything"])).rejects.toThrow("process.exit(1)");
    expect(allError()).toContain("Unknown command: deploy-everything");
  });
});

describe("run() - init command", () => {
  it("skips when config already exists", async () => {
    mockFindConfigFile.mockReturnValue("/project/ai-tools-hooks.config.ts");
    await run(["init"]);
    expect(allLog()).toContain("Config already exists: /project/ai-tools-hooks.config.ts");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("creates config file when none exists", async () => {
    mockFindConfigFile.mockReturnValue(null);
    await run(["init"]);
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(mockWriteFile).toHaveBeenCalledWith(
      "ai-hooks.config.ts",
      expect.stringContaining("defineConfig"),
      "utf-8",
    );
    expect(allLog()).toContain("Created ai-hooks.config.ts");
    expect(allLog()).toContain("Next steps:");
  });

  it("writes template with defineConfig, builtinHooks, and hook example", async () => {
    mockFindConfigFile.mockReturnValue(null);
    await run(["init"]);
    const firstCall = mockWriteFile.mock.calls[0]!;
    const writtenContent = firstCall[1] as string;
    expect(writtenContent).toContain(
      'import { defineConfig, hook, builtinHooks } from "@itz4blitz/ai-tools/hooks"',
    );
    expect(writtenContent).toContain("builtinHooks");
    expect(writtenContent).toContain("hook(");
    expect(writtenContent).toContain("settings:");
    expect(writtenContent).toContain("logLevel:");
    expect(writtenContent).toContain("hookTimeout:");
    expect(writtenContent).toContain("failMode:");
  });

  it("respects --dry-run flag and does not write files", async () => {
    mockFindConfigFile.mockReturnValue(null);
    await run(["init", "--dry-run"]);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(allLog()).toContain("[dry-run] Would create ai-hooks.config.ts");
  });

  it("shows next steps after creating config", async () => {
    mockFindConfigFile.mockReturnValue(null);
    await run(["init"]);
    const output = allLog();
    expect(output).toContain("Edit ai-hooks.config.ts");
    expect(output).toContain("ai-hooks detect");
    expect(output).toContain("ai-hooks install");
  });
});

describe("run() - detect command", () => {
  it("shows detection header", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    mockRegistryList.mockReturnValue([]);
    await run(["detect"]);
    expect(allLog()).toContain("Detecting AI coding tools...");
  });

  it("lists all registered adapters with check/cross icons", async () => {
    const detected = makeAdapter({ id: "claude-code", name: "Claude Code" });
    const missing = makeAdapter({ id: "codex", name: "Codex" });

    mockRegistryDetectAll.mockResolvedValue([detected]);
    mockRegistryList.mockReturnValue(["claude-code", "codex"]);
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return detected;
      if (id === "codex") return missing;
      return undefined;
    });

    await run(["detect"]);
    const output = allLog();
    expect(output).toContain("\u2713");
    expect(output).toContain("Claude Code");
    expect(output).toContain("\u2717");
    expect(output).toContain("Codex");
  });

  it("shows capabilities for each adapter", async () => {
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      capabilities: {
        beforeHooks: true,
        afterHooks: true,
        mcp: true,
        configFile: true,
        supportedEvents: ["shell:before"],
        blockableEvents: ["shell:before"],
      },
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);
    mockRegistryList.mockReturnValue(["claude-code"]);
    mockRegistryGet.mockReturnValue(adapter);

    await run(["detect"]);
    const output = allLog();
    expect(output).toContain("hooks");
    expect(output).toContain("mcp");
  });

  it("shows event count with --verbose flag", async () => {
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      capabilities: {
        beforeHooks: true,
        afterHooks: true,
        mcp: false,
        configFile: true,
        supportedEvents: ["shell:before", "shell:after", "tool:before"],
        blockableEvents: ["shell:before"],
      },
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);
    mockRegistryList.mockReturnValue(["claude-code"]);
    mockRegistryGet.mockReturnValue(adapter);

    await run(["detect", "--verbose"]);
    expect(allLog()).toContain("(3 events)");
  });

  it("does not show event count without --verbose flag", async () => {
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      capabilities: {
        beforeHooks: true,
        afterHooks: true,
        mcp: false,
        configFile: true,
        supportedEvents: ["shell:before", "shell:after"],
        blockableEvents: [],
      },
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);
    mockRegistryList.mockReturnValue(["claude-code"]);
    mockRegistryGet.mockReturnValue(adapter);

    await run(["detect"]);
    expect(allLog()).not.toContain("events)");
  });

  it("shows detection summary with counts", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    mockRegistryList.mockReturnValue(["claude-code", "codex", "gemini-cli"]);
    mockRegistryGet.mockReturnValue(adapter);

    await run(["detect"]);
    expect(allLog()).toContain("Detected 1/3 tools");
  });

  it("suggests init when tools detected but no config exists", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    mockRegistryList.mockReturnValue(["claude-code"]);
    mockRegistryGet.mockReturnValue(adapter);
    mockFindConfigFile.mockReturnValue(null);

    await run(["detect"]);
    expect(allLog()).toContain('"ai-hooks init"');
  });

  it("does not suggest init when config already exists", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    mockRegistryList.mockReturnValue(["claude-code"]);
    mockRegistryGet.mockReturnValue(adapter);
    mockFindConfigFile.mockReturnValue("/some/path/ai-tools-hooks.config.ts");

    await run(["detect"]);
    expect(allLog()).not.toContain('"ai-hooks init"');
  });

  it("does not suggest init when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    mockRegistryList.mockReturnValue(["claude-code"]);
    mockRegistryGet.mockReturnValue(makeAdapter());
    mockFindConfigFile.mockReturnValue(null);

    await run(["detect"]);
    expect(allLog()).not.toContain('"ai-hooks init"');
  });

  it("skips adapters that registry.get returns undefined for", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    mockRegistryList.mockReturnValue(["ghost-adapter"]);
    mockRegistryGet.mockReturnValue(undefined);

    await run(["detect"]);
    const output = allLog();
    expect(output).toContain("Detected 0/1 tools");
    expect(output).not.toContain("ghost-adapter");
  });
});

describe("run() - generate command", () => {
  const defaultConfig: AiHooksConfig = { hooks: [] };

  it("prints message when no tools detected and no --tools flag", async () => {
    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryDetectAll.mockResolvedValue([]);

    await run(["generate"]);
    expect(allLog()).toContain("No AI tools detected");
    expect(allLog()).toContain("--tools");
  });

  it("generates configs for detected adapters", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["generate"]);
    expect(allLog()).toContain("Generating configs for 1 tool(s)");
    expect(allLog()).toContain("Generated: .test-tool/hooks.json");
    expect(allLog()).toContain("Done!");
  });

  it("generates for multiple adapters", async () => {
    const adapter1 = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      generate: vi
        .fn<(hooks: HookDefinition[]) => Promise<GeneratedConfig[]>>()
        .mockResolvedValue([{ path: ".claude/settings.json", content: "{}", format: "json" }]),
    });
    const adapter2 = makeAdapter({
      id: "codex",
      name: "Codex",
      generate: vi
        .fn<(hooks: HookDefinition[]) => Promise<GeneratedConfig[]>>()
        .mockResolvedValue([{ path: ".codex/hooks.toml", content: "", format: "toml" }]),
    });

    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryDetectAll.mockResolvedValue([adapter1, adapter2]);

    await run(["generate"]);
    const output = allLog();
    expect(output).toContain("Generating configs for 2 tool(s)");
    expect(output).toContain("Generated: .claude/settings.json");
    expect(output).toContain("Generated: .codex/hooks.toml");
  });

  it("respects --dry-run and does not write files", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["generate", "--dry-run"]);
    expect(allLog()).toContain("[dry-run] Would write: .test-tool/hooks.json");
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it("writes config files to disk when not in dry-run", async () => {
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      generate: vi
        .fn<(hooks: HookDefinition[]) => Promise<GeneratedConfig[]>>()
        .mockResolvedValue([
          { path: ".claude/settings.json", content: '{"hooks":{}}', format: "json" },
        ]),
    });

    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["generate"]);
    expect(mockMkdir).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalled();
    const firstCall = mockWriteFile.mock.calls[0]!;
    const writtenContent = firstCall[1] as string;
    expect(writtenContent).toBe('{"hooks":{}}');
  });

  it("uses --tools flag to resolve specific adapters", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["generate", "--tools=claude-code"]);
    expect(allLog()).toContain("Generating configs for 1 tool(s)");
    expect(mockRegistryDetectAll).not.toHaveBeenCalled();
  });

  it("warns for unknown adapter IDs in --tools flag", async () => {
    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryGet.mockReturnValue(undefined);

    await run(["generate", "--tools=nonexistent"]);
    expect(allWarn()).toContain('Warning: Unknown adapter "nonexistent"');
    expect(allLog()).toContain("No AI tools detected");
  });

  it("resolves multiple comma-separated tools", async () => {
    const adapter1 = makeAdapter({ id: "claude-code", name: "Claude Code" });
    const adapter2 = makeAdapter({ id: "codex", name: "Codex" });
    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter1;
      if (id === "codex") return adapter2;
      return undefined;
    });

    await run(["generate", "--tools=claude-code,codex"]);
    expect(allLog()).toContain("Generating configs for 2 tool(s)");
  });

  it("trims whitespace in --tools values", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["generate", "--tools= claude-code "]);
    expect(allLog()).toContain("Generating configs for 1 tool(s)");
  });

  it("uses --config flag to load specific config file", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["generate", "--config=/custom/config.ts"]);
    expect(mockLoadConfig).toHaveBeenCalledWith("/custom/config.ts");
  });
});

describe("run() - install command", () => {
  const defaultConfig: AiHooksConfig = { hooks: [] };

  it("prints message when no tools detected", async () => {
    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryDetectAll.mockResolvedValue([]);

    await run(["install"]);
    expect(allLog()).toContain("No AI tools detected");
  });

  it("installs hooks into detected tools", async () => {
    const installFn = vi
      .fn<(configs: GeneratedConfig[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      install: installFn,
    });

    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["install"]);
    expect(installFn).toHaveBeenCalled();
    expect(allLog()).toContain("Installing hooks into 1 tool(s)");
    expect(allLog()).toContain("\u2713 Claude Code");
    expect(allLog()).toContain("Hooks installed!");
  });

  it("installs into multiple tools", async () => {
    const install1 = vi
      .fn<(configs: GeneratedConfig[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const install2 = vi
      .fn<(configs: GeneratedConfig[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter1 = makeAdapter({ id: "claude-code", name: "Claude Code", install: install1 });
    const adapter2 = makeAdapter({ id: "codex", name: "Codex", install: install2 });

    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryDetectAll.mockResolvedValue([adapter1, adapter2]);

    await run(["install"]);
    expect(install1).toHaveBeenCalled();
    expect(install2).toHaveBeenCalled();
    expect(allLog()).toContain("Installing hooks into 2 tool(s)");
    expect(allLog()).toContain("\u2713 Claude Code");
    expect(allLog()).toContain("\u2713 Codex");
  });

  it("respects --dry-run and does not call install", async () => {
    const installFn = vi
      .fn<(configs: GeneratedConfig[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      install: installFn,
      generate: vi
        .fn<(hooks: HookDefinition[]) => Promise<GeneratedConfig[]>>()
        .mockResolvedValue([{ path: ".claude/settings.json", content: "{}", format: "json" }]),
    });

    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["install", "--dry-run"]);
    expect(installFn).not.toHaveBeenCalled();
    expect(allLog()).toContain("[dry-run] Would install: .claude/settings.json");
  });

  it("uses --tools flag to install for specific tools only", async () => {
    const installFn = vi
      .fn<(configs: GeneratedConfig[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", install: installFn });

    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["install", "--tools=claude-code"]);
    expect(installFn).toHaveBeenCalled();
    expect(mockRegistryDetectAll).not.toHaveBeenCalled();
  });

  it("skips undetected tool in --tools and warns", async () => {
    const adapter = makeAdapter({
      id: "kiro",
      name: "Kiro",
      detect: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    });

    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "kiro") return adapter;
      return undefined;
    });

    await run(["install", "--tools=kiro"]);
    expect(allWarn()).toContain("Kiro not detected, skipping");
    expect(allWarn()).toContain("--force");
    expect(allLog()).toContain("No AI tools detected");
  });

  it("--force bypasses detection check for --tools", async () => {
    const installFn = vi
      .fn<(configs: GeneratedConfig[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "kiro",
      name: "Kiro",
      detect: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
      install: installFn,
    });

    mockLoadConfig.mockResolvedValue(defaultConfig);
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "kiro") return adapter;
      return undefined;
    });

    await run(["install", "--tools=kiro", "--force"]);
    expect(installFn).toHaveBeenCalled();
    expect(allLog()).toContain("Installing hooks into 1 tool(s)");
  });
});

describe("run() - uninstall command", () => {
  it("uninstalls from all detected tools", async () => {
    const uninstall1 = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const uninstall2 = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const adapter1 = makeAdapter({ id: "claude-code", name: "Claude Code", uninstall: uninstall1 });
    const adapter2 = makeAdapter({ id: "codex", name: "Codex", uninstall: uninstall2 });

    mockRegistryDetectAll.mockResolvedValue([adapter1, adapter2]);

    await run(["uninstall"]);
    expect(uninstall1).toHaveBeenCalled();
    expect(uninstall2).toHaveBeenCalled();
    expect(allLog()).toContain("\u2713 Removed from Claude Code");
    expect(allLog()).toContain("\u2713 Removed from Codex");
    expect(allLog()).toContain("Hooks uninstalled.");
  });

  it("uninstalls from specific tools with --tools flag", async () => {
    const uninstallFn = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", uninstall: uninstallFn });

    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["uninstall", "--tools=claude-code"]);
    expect(uninstallFn).toHaveBeenCalled();
    expect(allLog()).toContain("\u2713 Removed from Claude Code");
  });

  it("handles empty adapter list gracefully", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);

    await run(["uninstall"]);
    expect(allLog()).toContain("Hooks uninstalled.");
  });
});

describe("run() - list command", () => {
  it("shows message when no hooks are registered", async () => {
    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockGetHooks.mockReturnValue([]);

    await run(["list"]);
    expect(allLog()).toContain("No hooks registered");
    expect(allLog()).toContain("ai-hooks.config.ts");
  });

  it("lists registered hooks with phase, name, id, priority, and events", async () => {
    const hookDef: HookDefinition = {
      id: "block-rm-rf",
      name: "Block Dangerous Commands",
      events: ["shell:before"],
      phase: "before",
      priority: 10,
      handler: async (ctx, next) => {
        void ctx;
        await next();
      },
    };

    mockLoadConfig.mockResolvedValue({ hooks: [hookDef] });
    mockGetHooks.mockReturnValue([hookDef]);

    await run(["list"]);
    const output = allLog();
    expect(output).toContain("1 hook(s) registered:");
    expect(output).toContain("[before] Block Dangerous Commands");
    expect(output).toContain("id: block-rm-rf");
    expect(output).toContain("priority: 10");
    expect(output).toContain("events: shell:before");
  });

  it("lists multiple hooks", async () => {
    const hook1: HookDefinition = {
      id: "h1",
      name: "Hook One",
      events: ["shell:before"],
      phase: "before",
      handler: async (ctx, next) => {
        void ctx;
        await next();
      },
    };
    const hook2: HookDefinition = {
      id: "h2",
      name: "Hook Two",
      events: ["file:write", "file:edit"],
      phase: "before",
      handler: async (ctx, next) => {
        void ctx;
        await next();
      },
    };

    mockLoadConfig.mockResolvedValue({ hooks: [hook1, hook2] });
    mockGetHooks.mockReturnValue([hook1, hook2]);

    await run(["list"]);
    const output = allLog();
    expect(output).toContain("2 hook(s) registered:");
    expect(output).toContain("Hook One");
    expect(output).toContain("Hook Two");
    expect(output).toContain("events: file:write, file:edit");
  });

  it("shows disabled status for disabled hooks", async () => {
    const hookDef: HookDefinition = {
      id: "disabled-hook",
      name: "Disabled Hook",
      events: ["shell:before"],
      phase: "before",
      enabled: false,
      handler: async (ctx, next) => {
        void ctx;
        await next();
      },
    };

    mockLoadConfig.mockResolvedValue({ hooks: [hookDef] });
    mockGetHooks.mockReturnValue([hookDef]);

    await run(["list"]);
    expect(allLog()).toContain("(disabled)");
  });

  it("uses default priority of 100 when not specified", async () => {
    const hookDef: HookDefinition = {
      id: "default-priority",
      name: "Default Priority Hook",
      events: ["shell:before"],
      phase: "before",
      handler: async (ctx, next) => {
        void ctx;
        await next();
      },
    };

    mockLoadConfig.mockResolvedValue({ hooks: [hookDef] });
    mockGetHooks.mockReturnValue([hookDef]);

    await run(["list"]);
    expect(allLog()).toContain("priority: 100");
  });

  it("shows description with --verbose flag", async () => {
    const hookDef: HookDefinition = {
      id: "described-hook",
      name: "Described Hook",
      description: "This hook prevents dangerous shell commands",
      events: ["shell:before"],
      phase: "before",
      handler: async (ctx, next) => {
        void ctx;
        await next();
      },
    };

    mockLoadConfig.mockResolvedValue({ hooks: [hookDef] });
    mockGetHooks.mockReturnValue([hookDef]);

    await run(["list", "--verbose"]);
    expect(allLog()).toContain("This hook prevents dangerous shell commands");
  });

  it("does not show description without --verbose flag", async () => {
    const hookDef: HookDefinition = {
      id: "described-hook",
      name: "Described Hook",
      description: "This hook prevents dangerous shell commands",
      events: ["shell:before"],
      phase: "before",
      handler: async (ctx, next) => {
        void ctx;
        await next();
      },
    };

    mockLoadConfig.mockResolvedValue({ hooks: [hookDef] });
    mockGetHooks.mockReturnValue([hookDef]);

    await run(["list"]);
    expect(allLog()).not.toContain("This hook prevents dangerous shell commands");
  });

  it("uses --config flag for loading config", async () => {
    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockGetHooks.mockReturnValue([]);

    await run(["list", "--config=/custom/path.ts"]);
    expect(mockLoadConfig).toHaveBeenCalledWith("/custom/path.ts");
  });
});

describe("run() - status command", () => {
  it("shows status header and config path when config exists", async () => {
    mockFindConfigFile.mockReturnValue("/project/ai-tools-hooks.config.ts");
    mockRegistryDetectAll.mockResolvedValue([]);
    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockGetHooks.mockReturnValue([]);

    await run(["status"]);
    const output = allLog();
    expect(output).toContain("ai-hooks status");
    expect(output).toContain("Config: /project/ai-tools-hooks.config.ts");
    expect(output).toContain("Tools:  0 detected");
    expect(output).toContain("Hooks:  0 registered");
  });

  it('shows "not found" when no config exists', async () => {
    mockFindConfigFile.mockReturnValue(null);
    mockRegistryDetectAll.mockResolvedValue([]);

    await run(["status"]);
    expect(allLog()).toContain("Config: not found");
  });

  it("does not show hook count when no config exists", async () => {
    mockFindConfigFile.mockReturnValue(null);
    mockRegistryDetectAll.mockResolvedValue([]);

    await run(["status"]);
    expect(allLog()).not.toContain("Hooks:");
    expect(mockLoadConfig).not.toHaveBeenCalled();
  });

  it("shows detected tools with checkmarks", async () => {
    const adapter1 = makeAdapter({ id: "claude-code", name: "Claude Code" });
    const adapter2 = makeAdapter({ id: "codex", name: "Codex" });

    mockFindConfigFile.mockReturnValue(null);
    mockRegistryDetectAll.mockResolvedValue([adapter1, adapter2]);

    await run(["status"]);
    const output = allLog();
    expect(output).toContain("Tools:  2 detected");
    expect(output).toContain("\u2713 Claude Code (claude-code)");
    expect(output).toContain("\u2713 Codex (codex)");
  });

  it("shows hook count when config is present", async () => {
    const hookDef: HookDefinition = {
      id: "h1",
      name: "Hook",
      events: ["shell:before"],
      phase: "before",
      handler: async (ctx, next) => {
        void ctx;
        await next();
      },
    };

    mockFindConfigFile.mockReturnValue("/project/ai-tools-hooks.config.ts");
    mockRegistryDetectAll.mockResolvedValue([]);
    mockLoadConfig.mockResolvedValue({ hooks: [hookDef] });
    mockGetHooks.mockReturnValue([hookDef]);

    await run(["status"]);
    expect(allLog()).toContain("Hooks:  1 registered");
  });

  it("uses --config flag for loading config", async () => {
    mockFindConfigFile.mockReturnValue("/some/config.ts");
    mockRegistryDetectAll.mockResolvedValue([]);
    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockGetHooks.mockReturnValue([]);

    await run(["status", "--config=/custom/path.ts"]);
    expect(mockLoadConfig).toHaveBeenCalledWith("/custom/path.ts");
  });
});

describe("run() - flag parsing", () => {
  it("parses --tools flag with = syntax", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["generate", "--tools=claude-code"]);
    expect(mockRegistryGet).toHaveBeenCalledWith("claude-code");
    expect(mockRegistryDetectAll).not.toHaveBeenCalled();
  });

  it("parses --config flag with = syntax", async () => {
    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockGetHooks.mockReturnValue([]);

    await run(["list", "--config=/path/to/config.ts"]);
    expect(mockLoadConfig).toHaveBeenCalledWith("/path/to/config.ts");
  });

  it("parses --verbose flag", async () => {
    const hookDef: HookDefinition = {
      id: "h1",
      name: "Hook",
      description: "Verbose description here",
      events: ["shell:before"],
      phase: "before",
      handler: async (ctx, next) => {
        void ctx;
        await next();
      },
    };

    mockLoadConfig.mockResolvedValue({ hooks: [hookDef] });
    mockGetHooks.mockReturnValue([hookDef]);

    await run(["list", "--verbose"]);
    expect(allLog()).toContain("Verbose description here");
  });

  it("parses --dry-run flag", async () => {
    mockFindConfigFile.mockReturnValue(null);
    await run(["init", "--dry-run"]);
    expect(allLog()).toContain("[dry-run]");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("ignores unknown flags gracefully", async () => {
    mockFindConfigFile.mockReturnValue(null);
    await run(["init", "--unknown-flag", "--dry-run"]);
    expect(allLog()).toContain("[dry-run]");
  });

  it("handles multiple flags together", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["generate", "--tools=claude-code", "--dry-run", "--verbose", "--config=/custom.ts"]);
    expect(mockLoadConfig).toHaveBeenCalledWith("/custom.ts");
    expect(allLog()).toContain("[dry-run]");
  });

  it("parses --force flag", async () => {
    const adapter = makeAdapter({
      id: "kiro",
      name: "Kiro",
      detect: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    });
    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "kiro") return adapter;
      return undefined;
    });

    await run(["generate", "--tools=kiro", "--force"]);
    expect(allLog()).toContain("Generating configs for 1 tool(s)");
  });
});

describe("run() - error propagation", () => {
  it("propagates loadConfig errors for generate", async () => {
    mockLoadConfig.mockRejectedValue(new Error("Config file not found"));
    await expect(run(["generate"])).rejects.toThrow("Config file not found");
  });

  it("propagates loadConfig errors for install", async () => {
    mockLoadConfig.mockRejectedValue(new Error("Config file not found"));
    await expect(run(["install"])).rejects.toThrow("Config file not found");
  });

  it("propagates loadConfig errors for list", async () => {
    mockLoadConfig.mockRejectedValue(new Error("Config file not found"));
    await expect(run(["list"])).rejects.toThrow("Config file not found");
  });

  it("propagates adapter generate errors", async () => {
    const adapter = makeAdapter({
      id: "broken",
      name: "Broken",
      generate: vi
        .fn<(hooks: HookDefinition[]) => Promise<GeneratedConfig[]>>()
        .mockRejectedValue(new Error("generate failed")),
    });

    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await expect(run(["generate"])).rejects.toThrow("generate failed");
  });

  it("propagates adapter install errors", async () => {
    const adapter = makeAdapter({
      id: "broken",
      name: "Broken",
      install: vi
        .fn<(configs: GeneratedConfig[]) => Promise<void>>()
        .mockRejectedValue(new Error("install failed")),
    });

    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await expect(run(["install"])).rejects.toThrow("install failed");
  });

  it("propagates adapter uninstall errors", async () => {
    const adapter = makeAdapter({
      id: "broken",
      name: "Broken",
      uninstall: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("uninstall failed")),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await expect(run(["uninstall"])).rejects.toThrow("uninstall failed");
  });
});

describe("run() - edge cases", () => {
  it("handles adapter with no capabilities flags set", async () => {
    const adapter = makeAdapter({
      id: "minimal",
      name: "Minimal Tool",
      capabilities: {
        beforeHooks: false,
        afterHooks: false,
        mcp: false,
        configFile: false,
        supportedEvents: [],
        blockableEvents: [],
      },
    });

    mockRegistryDetectAll.mockResolvedValue([]);
    mockRegistryList.mockReturnValue(["minimal"]);
    mockRegistryGet.mockReturnValue(adapter);

    await run(["detect"]);
    const output = allLog();
    expect(output).toContain("Minimal Tool");
    // The caps line should not show "hooks" or "mcp" when not supported
    expect(output).not.toContain("hooks");
    expect(output).not.toContain("mcp");
  });

  it("handles adapter that generates empty config list", async () => {
    const adapter = makeAdapter({
      id: "empty",
      name: "Empty",
      generate: vi
        .fn<(hooks: HookDefinition[]) => Promise<GeneratedConfig[]>>()
        .mockResolvedValue([]),
    });

    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["generate"]);
    expect(allLog()).toContain("Generating configs for 1 tool(s)");
    expect(allLog()).toContain("Done!");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("handles adapter that generates multiple config files", async () => {
    const adapter = makeAdapter({
      id: "multi",
      name: "Multi Config Tool",
      generate: vi.fn<(hooks: HookDefinition[]) => Promise<GeneratedConfig[]>>().mockResolvedValue([
        { path: "config/hooks.json", content: "{}", format: "json" },
        { path: "config/settings.json", content: "{}", format: "json" },
        { path: "config/rules.yaml", content: "", format: "yaml" },
      ]),
    });

    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["generate"]);
    const output = allLog();
    expect(output).toContain("Generated: config/hooks.json");
    expect(output).toContain("Generated: config/settings.json");
    expect(output).toContain("Generated: config/rules.yaml");
  });

  it("passes hooks from loaded config to adapter.generate", async () => {
    const hookDef: HookDefinition = {
      id: "test-hook",
      name: "Test",
      events: ["shell:before"],
      phase: "before",
      handler: async (ctx, next) => {
        void ctx;
        await next();
      },
    };

    const generateFn = vi
      .fn<(hooks: HookDefinition[]) => Promise<GeneratedConfig[]>>()
      .mockResolvedValue([]);

    const adapter = makeAdapter({ id: "test", name: "Test", generate: generateFn });

    mockLoadConfig.mockResolvedValue({ hooks: [hookDef] });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["generate"]);
    expect(generateFn).toHaveBeenCalledWith([hookDef]);
  });

  it("install dry-run prints each generated config path", async () => {
    const adapter = makeAdapter({
      id: "multi",
      name: "Multi",
      generate: vi.fn<(hooks: HookDefinition[]) => Promise<GeneratedConfig[]>>().mockResolvedValue([
        { path: "file1.json", content: "{}", format: "json" },
        { path: "file2.json", content: "{}", format: "json" },
      ]),
    });

    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["install", "--dry-run"]);
    const output = allLog();
    expect(output).toContain("[dry-run] Would install: file1.json");
    expect(output).toContain("[dry-run] Would install: file2.json");
  });

  it("mixed known and unknown tools in --tools flag", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockLoadConfig.mockResolvedValue({ hooks: [] });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["generate", "--tools=claude-code,nonexistent"]);
    expect(allWarn()).toContain('Warning: Unknown adapter "nonexistent"');
    expect(allLog()).toContain("Generating configs for 1 tool(s)");
  });

  it("status with config and detected tools shows all info", async () => {
    const hookDef: HookDefinition = {
      id: "h1",
      name: "Security Hook",
      events: ["shell:before"],
      phase: "before",
      handler: async (ctx, next) => {
        void ctx;
        await next();
      },
    };

    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });

    mockFindConfigFile.mockReturnValue("/project/ai-tools-hooks.config.ts");
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    mockLoadConfig.mockResolvedValue({ hooks: [hookDef] });
    mockGetHooks.mockReturnValue([hookDef]);

    await run(["status"]);
    const output = allLog();
    expect(output).toContain("ai-hooks status");
    expect(output).toContain("Config: /project/ai-tools-hooks.config.ts");
    expect(output).toContain("Tools:  1 detected");
    expect(output).toContain("Hooks:  1 registered");
    expect(output).toContain("\u2713 Claude Code (claude-code)");
  });
});
