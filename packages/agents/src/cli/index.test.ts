import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentDefinition, GeneratedFile } from "../types/index.js";
import type { BaseAgentAdapter } from "../adapters/base.js";

const {
  mockRegistryDetectAll,
  mockRegistryList,
  mockRegistryGet,
  mockRegistryGetAll,
  mockWriteFile,
  mockMkdir,
  mockReadFile,
  mockExistsSync,
} = vi.hoisted(() => ({
  mockRegistryDetectAll: vi.fn(),
  mockRegistryList: vi.fn(),
  mockRegistryGet: vi.fn(),
  mockRegistryGetAll: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockReadFile: vi.fn(),
  mockExistsSync: vi.fn(),
}));

vi.mock("../adapters/all.js", () => ({}));

vi.mock("../adapters/registry.js", () => ({
  registry: {
    detectAll: (...args: unknown[]) => mockRegistryDetectAll(...args),
    list: () => mockRegistryList(),
    get: (id: string) => mockRegistryGet(id),
    getAll: () => mockRegistryGetAll(),
  },
}));

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

import { run } from "./index.js";

function makeAdapter(overrides: Partial<BaseAgentAdapter> = {}): BaseAgentAdapter {
  return {
    id: overrides.id ?? "test-tool",
    name: overrides.name ?? "Test Tool",
    nativeSupport: true,
    configDir: ".test",
    detect: overrides.detect ?? vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    generate:
      overrides.generate ??
      vi
        .fn<(agents: AgentDefinition[]) => Promise<GeneratedFile[]>>()
        .mockResolvedValue([{ path: ".test/agents/a.md", content: "test", format: "md" }]),
    import: overrides.import ?? vi.fn<() => Promise<AgentDefinition[]>>().mockResolvedValue([]),
    install:
      overrides.install ??
      vi.fn<(files: GeneratedFile[]) => Promise<void>>().mockResolvedValue(undefined),
    uninstall: overrides.uninstall ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as BaseAgentAdapter;
}

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
  mockExistsSync.mockReturnValue(false);
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  process.exit = originalExit;
});

function allLog(): string {
  return logOutput.join("\n");
}

function allError(): string {
  return errorOutput.join("\n");
}

function allWarn(): string {
  return warnOutput.join("\n");
}

describe("run() - help output", () => {
  it("prints help text for help command", async () => {
    await run(["help"]);
    expect(allLog()).toContain("ai-agents");
    expect(allLog()).toContain("USAGE:");
    expect(allLog()).toContain("COMMANDS:");
  });

  it("prints help text for --help flag", async () => {
    await run(["--help"]);
    expect(allLog()).toContain("ai-agents");
  });

  it("prints help text for -h flag", async () => {
    await run(["-h"]);
    expect(allLog()).toContain("ai-agents");
  });

  it("prints help text when no arguments provided", async () => {
    await run([]);
    expect(allLog()).toContain("ai-agents");
  });

  it("includes all documented commands in help text", async () => {
    await run(["help"]);
    const output = allLog();
    for (const cmd of [
      "init",
      "detect",
      "generate",
      "install",
      "import",
      "sync",
      "export",
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

describe("run() - init command", () => {
  it("skips when config already exists", async () => {
    mockExistsSync.mockReturnValue(true);
    await run(["init"]);
    expect(allLog()).toContain("Config already exists: ai-agents.config.ts");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("creates config file importing from @itz4blitz/ai-tools/agents", async () => {
    mockExistsSync.mockReturnValue(false);
    await run(["init"]);
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(mockWriteFile).toHaveBeenCalledWith(
      "ai-agents.config.ts",
      expect.stringContaining('import { defineConfig } from "@itz4blitz/ai-tools/agents"'),
      "utf-8",
    );
    expect(allLog()).toContain("Created ai-agents.config.ts");
    expect(allLog()).toContain("Next steps:");
  });

  it("respects --dry-run flag and does not write files", async () => {
    mockExistsSync.mockReturnValue(false);
    await run(["init", "--dry-run"]);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(allLog()).toContain("[dry-run] Would create ai-agents.config.ts");
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

describe("run() - detect command", () => {
  it("shows detection header", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    mockRegistryGetAll.mockReturnValue([]);
    await run(["detect"]);
    expect(allLog()).toContain("Detecting AI coding tools");
  });

  it("lists detected adapters", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    mockRegistryGetAll.mockReturnValue([adapter]);
    await run(["detect"]);
    expect(allLog()).toContain("Claude Code");
    expect(allLog()).toContain("\u2713");
  });

  it("lists undetected adapters with cross mark", async () => {
    const detected = makeAdapter({ id: "claude-code", name: "Claude Code" });
    const missing = makeAdapter({ id: "cursor", name: "Cursor" });

    mockRegistryDetectAll.mockResolvedValue([detected]);
    mockRegistryGetAll.mockReturnValue([detected, missing]);

    await run(["detect"]);
    const output = allLog();
    expect(output).toContain("\u2713");
    expect(output).toContain("Claude Code");
    expect(output).toContain("\u2717");
    expect(output).toContain("Cursor");
  });

  it("shows detection summary with counts", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    mockRegistryGetAll.mockReturnValue([adapter, makeAdapter({ id: "cursor", name: "Cursor" })]);

    await run(["detect"]);
    expect(allLog()).toContain("Detected 1/2 tools");
  });

  it("shows configDir for each adapter", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    mockRegistryGetAll.mockReturnValue([adapter]);

    await run(["detect"]);
    expect(allLog()).toContain(".test");
  });
});

describe("run() - generate command", () => {
  it("prints message when no tools detected and no --tools flag", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["generate"]);
    expect(allLog()).toContain("No AI tools detected");
  });

  it("generates configs for detected adapters", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    await run(["generate"]);
    expect(allLog()).toContain("Generating");
    expect(allLog()).toContain("Done!");
  });

  it("uses --tools flag to resolve specific adapters", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });
    await run(["generate", "--tools=claude-code"]);
    expect(allLog()).toContain("Generating");
    expect(mockRegistryDetectAll).not.toHaveBeenCalled();
  });

  it("warns for unknown adapter IDs in --tools flag", async () => {
    mockRegistryGet.mockReturnValue(undefined);
    await run(["generate", "--tools=nonexistent"]);
    expect(allWarn()).toContain("Unknown adapter");
    expect(allLog()).toContain("No AI tools detected");
  });

  it("respects --dry-run and does not write files", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["generate", "--dry-run"]);
    expect(allLog()).toContain("[dry-run] Would write:");
  });

  it("generates for multiple adapters", async () => {
    const adapter1 = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      generate: vi
        .fn<(agents: AgentDefinition[]) => Promise<GeneratedFile[]>>()
        .mockResolvedValue([{ path: ".claude/agents/a.md", content: "test", format: "md" }]),
    });
    const adapter2 = makeAdapter({
      id: "cursor",
      name: "Cursor",
      generate: vi
        .fn<(agents: AgentDefinition[]) => Promise<GeneratedFile[]>>()
        .mockResolvedValue([{ path: ".cursor/agents/a.md", content: "test", format: "md" }]),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter1, adapter2]);

    await run(["generate"]);
    const output = allLog();
    expect(output).toContain("Generating agent configs for 2 tool(s)");
    expect(output).toContain("Generated: .claude/agents/a.md");
    expect(output).toContain("Generated: .cursor/agents/a.md");
  });

  it("handles adapter that generates empty file list", async () => {
    const adapter = makeAdapter({
      id: "empty",
      name: "Empty",
      generate: vi
        .fn<(agents: AgentDefinition[]) => Promise<GeneratedFile[]>>()
        .mockResolvedValue([]),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["generate"]);
    expect(allLog()).toContain("Generating agent configs for 1 tool(s)");
    expect(allLog()).toContain("Done!");
  });

  it("handles mixed known and unknown tools in --tools flag", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["generate", "--tools=claude-code,nonexistent"]);
    expect(allWarn()).toContain('Warning: Unknown adapter "nonexistent"');
    expect(allLog()).toContain("Generating agent configs for 1 tool(s)");
  });

  it("resolves multiple comma-separated tools", async () => {
    const adapter1 = makeAdapter({ id: "claude-code", name: "Claude Code" });
    const adapter2 = makeAdapter({ id: "cursor", name: "Cursor" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter1;
      if (id === "cursor") return adapter2;
      return undefined;
    });

    await run(["generate", "--tools=claude-code,cursor"]);
    expect(allLog()).toContain("Generating agent configs for 2 tool(s)");
  });

  it("trims whitespace in --tools values", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["generate", "--tools= claude-code "]);
    expect(allLog()).toContain("Generating agent configs for 1 tool(s)");
  });
});

describe("run() - install command", () => {
  it("prints message when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["install"]);
    expect(allLog()).toContain("No AI tools detected");
  });

  it("installs agents into detected tools", async () => {
    const installFn = vi
      .fn<(files: GeneratedFile[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", install: installFn });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    await run(["install"]);
    expect(installFn).toHaveBeenCalled();
    expect(allLog()).toContain("Claude Code");
  });

  it("respects --dry-run and does not call install", async () => {
    const installFn = vi
      .fn<(files: GeneratedFile[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      install: installFn,
      generate: vi
        .fn<(agents: AgentDefinition[]) => Promise<GeneratedFile[]>>()
        .mockResolvedValue([{ path: ".claude/agents/a.md", content: "test", format: "md" }]),
    });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["install", "--dry-run"]);
    expect(installFn).not.toHaveBeenCalled();
    expect(allLog()).toContain("[dry-run] Would install: .claude/agents/a.md");
  });

  it("installs into multiple tools", async () => {
    const install1 = vi
      .fn<(files: GeneratedFile[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const install2 = vi
      .fn<(files: GeneratedFile[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter1 = makeAdapter({ id: "claude-code", name: "Claude Code", install: install1 });
    const adapter2 = makeAdapter({ id: "cursor", name: "Cursor", install: install2 });

    mockRegistryDetectAll.mockResolvedValue([adapter1, adapter2]);

    await run(["install"]);
    expect(install1).toHaveBeenCalled();
    expect(install2).toHaveBeenCalled();
    expect(allLog()).toContain("Installing agents into 2 tool(s)");
    expect(allLog()).toContain("\u2713 Claude Code");
    expect(allLog()).toContain("\u2713 Cursor");
    expect(allLog()).toContain("Agents installed!");
  });

  it("uses --tools flag to install for specific tools only", async () => {
    const installFn = vi
      .fn<(files: GeneratedFile[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", install: installFn });

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
      .fn<(files: GeneratedFile[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "kiro",
      name: "Kiro",
      detect: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
      install: installFn,
    });

    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "kiro") return adapter;
      return undefined;
    });

    await run(["install", "--tools=kiro", "--force"]);
    expect(installFn).toHaveBeenCalled();
    expect(allLog()).toContain("Installing agents into 1 tool(s)");
  });

  it("shows dry-run output for multiple generated files", async () => {
    const adapter = makeAdapter({
      id: "multi",
      name: "Multi",
      generate: vi.fn<(agents: AgentDefinition[]) => Promise<GeneratedFile[]>>().mockResolvedValue([
        { path: "file1.md", content: "# A", format: "md" },
        { path: "file2.md", content: "# B", format: "md" },
      ]),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["install", "--dry-run"]);
    const output = allLog();
    expect(output).toContain("[dry-run] Would install: file1.md");
    expect(output).toContain("[dry-run] Would install: file2.md");
  });
});

describe("run() - import command", () => {
  it("prints message when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["import"]);
    expect(allLog()).toContain("No AI tools detected");
  });

  it("imports agents from detected tools", async () => {
    const importFn = vi
      .fn<() => Promise<AgentDefinition[]>>()
      .mockResolvedValue([{ id: "agent1", name: "Agent 1", instructions: "Do stuff." }]);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    await run(["import"]);
    expect(importFn).toHaveBeenCalled();
    expect(allLog()).toContain("Agent 1");
  });

  it("shows 'no agents found' message when adapter has no agents", async () => {
    const importFn = vi.fn<() => Promise<AgentDefinition[]>>().mockResolvedValue([]);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    await run(["import"]);
    expect(allLog()).toContain("Claude Code: no agents found");
  });

  it("imports from multiple tools and shows counts", async () => {
    const import1 = vi
      .fn<() => Promise<AgentDefinition[]>>()
      .mockResolvedValue([{ id: "a1", name: "Agent A1", instructions: "A1 instructions" }]);
    const import2 = vi.fn<() => Promise<AgentDefinition[]>>().mockResolvedValue([
      { id: "a2", name: "Agent A2", instructions: "A2 instructions" },
      { id: "a3", name: "Agent A3", instructions: "A3 instructions" },
    ]);
    const adapter1 = makeAdapter({ id: "claude-code", name: "Claude Code", import: import1 });
    const adapter2 = makeAdapter({ id: "cursor", name: "Cursor", import: import2 });

    mockRegistryDetectAll.mockResolvedValue([adapter1, adapter2]);

    await run(["import"]);
    const output = allLog();
    expect(output).toContain("Importing agents from 2 tool(s)");
    expect(output).toContain("Claude Code: 1 agent(s)");
    expect(output).toContain("Agent A1 (a1)");
    expect(output).toContain("Cursor: 2 agent(s)");
    expect(output).toContain("Agent A2 (a2)");
    expect(output).toContain("Agent A3 (a3)");
  });

  it("uses --tools flag to import from specific tools", async () => {
    const importFn = vi
      .fn<() => Promise<AgentDefinition[]>>()
      .mockResolvedValue([{ id: "agent1", name: "Agent 1", instructions: "Do stuff." }]);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["import", "--tools=claude-code"]);
    expect(importFn).toHaveBeenCalled();
    expect(mockRegistryDetectAll).not.toHaveBeenCalled();
  });
});

describe("run() - export command", () => {
  it("prints message when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["export"]);
    expect(allLog()).toContain("No AI tools detected");
  });

  it("exports agents as JSON to stdout", async () => {
    const agents: AgentDefinition[] = [
      { id: "agent1", name: "Agent 1", instructions: "Do stuff." },
    ];
    const importFn = vi.fn<() => Promise<AgentDefinition[]>>().mockResolvedValue(agents);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["export"]);
    const output = allLog();
    expect(output).toContain('"id": "agent1"');
    expect(output).toContain('"name": "Agent 1"');
    expect(output).toContain('"instructions": "Do stuff."');
  });

  it("uses --tools flag to export from specific tool", async () => {
    const importFn = vi.fn<() => Promise<AgentDefinition[]>>().mockResolvedValue([]);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["export", "--tools=claude-code"]);
    expect(importFn).toHaveBeenCalled();
    expect(mockRegistryDetectAll).not.toHaveBeenCalled();
  });
});

describe("run() - sync command", () => {
  it("prints message when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["sync"]);
    expect(allLog()).toContain("No AI tools detected");
  });

  it("syncs agents from first tool to others", async () => {
    const agents: AgentDefinition[] = [{ id: "a1", name: "Agent 1", instructions: "Do stuff." }];
    const importFn = vi.fn<() => Promise<AgentDefinition[]>>().mockResolvedValue(agents);
    const installFn = vi
      .fn<(files: GeneratedFile[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const generateFn = vi
      .fn<(agents: AgentDefinition[]) => Promise<GeneratedFile[]>>()
      .mockResolvedValue([{ path: ".cursor/agents/a1.md", content: "test", format: "md" }]);

    const source = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });
    const target = makeAdapter({
      id: "cursor",
      name: "Cursor",
      generate: generateFn,
      install: installFn,
    });

    mockRegistryDetectAll.mockResolvedValue([source, target]);

    await run(["sync"]);
    expect(importFn).toHaveBeenCalled();
    expect(generateFn).toHaveBeenCalledWith(agents);
    expect(installFn).toHaveBeenCalled();
    expect(allLog()).toContain("Syncing 1 agent(s) from Claude Code to 1 tool(s)");
    expect(allLog()).toContain("\u2713 Cursor");
    expect(allLog()).toContain("Done!");
  });

  it("respects --dry-run during sync", async () => {
    const agents: AgentDefinition[] = [{ id: "a1", name: "Agent 1", instructions: "Do stuff." }];
    const importFn = vi.fn<() => Promise<AgentDefinition[]>>().mockResolvedValue(agents);
    const installFn = vi
      .fn<(files: GeneratedFile[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const generateFn = vi
      .fn<(agents: AgentDefinition[]) => Promise<GeneratedFile[]>>()
      .mockResolvedValue([{ path: ".cursor/agents/a1.md", content: "test", format: "md" }]);

    const source = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });
    const target = makeAdapter({
      id: "cursor",
      name: "Cursor",
      generate: generateFn,
      install: installFn,
    });

    mockRegistryDetectAll.mockResolvedValue([source, target]);

    await run(["sync", "--dry-run"]);
    expect(installFn).not.toHaveBeenCalled();
    expect(allLog()).toContain("[dry-run] Would write: .cursor/agents/a1.md");
  });

  it("syncs with only one tool (no targets to sync to)", async () => {
    const agents: AgentDefinition[] = [{ id: "a1", name: "Agent 1", instructions: "Do stuff." }];
    const importFn = vi.fn<() => Promise<AgentDefinition[]>>().mockResolvedValue(agents);
    const source = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });

    mockRegistryDetectAll.mockResolvedValue([source]);

    await run(["sync"]);
    expect(allLog()).toContain("Syncing 1 agent(s) from Claude Code to 0 tool(s)");
    expect(allLog()).toContain("Done!");
  });
});

describe("run() - flag parsing", () => {
  it("parses --tools flag with = syntax", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["generate", "--tools=claude-code"]);
    expect(mockRegistryGet).toHaveBeenCalledWith("claude-code");
    expect(mockRegistryDetectAll).not.toHaveBeenCalled();
  });

  it("parses --dry-run flag", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["generate", "--dry-run"]);
    expect(allLog()).toContain("[dry-run]");
  });

  it("parses --verbose flag", async () => {
    // Verbose is parsed but not used differently in generate; just ensure no crash
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["generate", "--verbose"]);
    expect(allLog()).toContain("Done!");
  });

  it("handles multiple flags together", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["generate", "--tools=claude-code", "--dry-run", "--verbose"]);
    expect(allLog()).toContain("[dry-run]");
  });

  it("parses --force flag", async () => {
    const adapter = makeAdapter({
      id: "kiro",
      name: "Kiro",
      detect: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "kiro") return adapter;
      return undefined;
    });

    await run(["generate", "--tools=kiro", "--force"]);
    expect(allLog()).toContain("Generating agent configs for 1 tool(s)");
  });
});

describe("run() - error propagation", () => {
  it("propagates adapter generate errors", async () => {
    const adapter = makeAdapter({
      id: "broken",
      name: "Broken",
      generate: vi
        .fn<(agents: AgentDefinition[]) => Promise<GeneratedFile[]>>()
        .mockRejectedValue(new Error("generate failed")),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await expect(run(["generate"])).rejects.toThrow("generate failed");
  });

  it("propagates adapter install errors", async () => {
    const adapter = makeAdapter({
      id: "broken",
      name: "Broken",
      install: vi
        .fn<(files: GeneratedFile[]) => Promise<void>>()
        .mockRejectedValue(new Error("install failed")),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await expect(run(["install"])).rejects.toThrow("install failed");
  });

  it("propagates adapter import errors", async () => {
    const adapter = makeAdapter({
      id: "broken",
      name: "Broken",
      import: vi
        .fn<() => Promise<AgentDefinition[]>>()
        .mockRejectedValue(new Error("import failed")),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await expect(run(["import"])).rejects.toThrow("import failed");
  });

  it("propagates adapter export errors", async () => {
    const adapter = makeAdapter({
      id: "broken",
      name: "Broken",
      import: vi
        .fn<() => Promise<AgentDefinition[]>>()
        .mockRejectedValue(new Error("export failed")),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await expect(run(["export"])).rejects.toThrow("export failed");
  });
});

describe("run() - edge cases", () => {
  it("handles adapter that generates multiple files", async () => {
    const adapter = makeAdapter({
      id: "multi",
      name: "Multi Config Tool",
      generate: vi.fn<(agents: AgentDefinition[]) => Promise<GeneratedFile[]>>().mockResolvedValue([
        { path: "agents/a1.md", content: "# A1", format: "md" },
        { path: "agents/a2.md", content: "# A2", format: "md" },
        { path: "agents/a3.md", content: "# A3", format: "md" },
      ]),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["generate"]);
    const output = allLog();
    expect(output).toContain("Generated: agents/a1.md");
    expect(output).toContain("Generated: agents/a2.md");
    expect(output).toContain("Generated: agents/a3.md");
  });

  it("detect with zero registered adapters", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    mockRegistryGetAll.mockReturnValue([]);

    await run(["detect"]);
    expect(allLog()).toContain("Detected 0/0 tools");
  });
});
