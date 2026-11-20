import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RuleDefinition, GeneratedFile } from "../types/index.js";
import type { BaseRuleAdapter } from "../adapters/base.js";

const { mockRegistryDetectAll, mockRegistryList, mockRegistryGet, mockWriteFile, mockMkdir } =
  vi.hoisted(() => ({
    mockRegistryDetectAll: vi.fn(),
    mockRegistryList: vi.fn(),
    mockRegistryGet: vi.fn(),
    mockWriteFile: vi.fn(),
    mockMkdir: vi.fn(),
  }));

vi.mock("../adapters/all.js", () => ({}));

vi.mock("../adapters/registry.js", () => ({
  registry: {
    detectAll: (...args: unknown[]) => mockRegistryDetectAll(...args),
    list: () => mockRegistryList(),
    get: (id: string) => mockRegistryGet(id),
    register: vi.fn(),
  },
}));

vi.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

vi.mock("node:fs", () => ({
  existsSync: () => false,
}));

import { run } from "./index.js";

function makeAdapter(overrides: Partial<BaseRuleAdapter> = {}): BaseRuleAdapter {
  return {
    id: overrides.id ?? "test-tool",
    name: overrides.name ?? "Test Tool",
    nativeSupport: true,
    configDir: overrides.configDir ?? ".test/rules",
    detect: overrides.detect ?? vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    generate:
      overrides.generate ??
      vi
        .fn<(rules: RuleDefinition[]) => Promise<GeneratedFile[]>>()
        .mockResolvedValue([
          { path: ".test/rules/test.md", content: "# Test\n\nContent\n", format: "md" },
        ]),
    import: overrides.import ?? vi.fn<() => Promise<RuleDefinition[]>>().mockResolvedValue([]),
    install:
      overrides.install ??
      vi.fn<(files: GeneratedFile[]) => Promise<void>>().mockResolvedValue(undefined),
    uninstall: overrides.uninstall ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as BaseRuleAdapter;
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
  it('prints help text for "help" command', async () => {
    await run(["help"]);
    expect(allLog()).toContain("ai-rules");
    expect(allLog()).toContain("USAGE:");
    expect(allLog()).toContain("COMMANDS:");
    expect(allLog()).toContain("OPTIONS:");
    expect(allLog()).toContain("EXAMPLES:");
  });

  it("prints help text for --help flag", async () => {
    await run(["--help"]);
    expect(allLog()).toContain("ai-rules");
    expect(allLog()).toContain("COMMANDS");
  });

  it("prints help text for -h flag", async () => {
    await run(["-h"]);
    expect(allLog()).toContain("ai-rules");
  });

  it("prints help text when no arguments provided", async () => {
    await run([]);
    expect(allLog()).toContain("ai-rules");
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
  it("creates config file", async () => {
    await run(["init"]);
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(mockWriteFile).toHaveBeenCalledWith(
      "ai-rules.config.ts",
      expect.stringContaining("defineRulesConfig"),
      "utf-8",
    );
    expect(allLog()).toContain("Created ai-rules.config.ts");
  });

  it("respects --dry-run flag and does not write files", async () => {
    await run(["init", "--dry-run"]);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(allLog()).toContain("[dry-run] Would create ai-rules.config.ts");
  });

  it("writes template with defineRulesConfig and example rule", async () => {
    await run(["init"]);
    const firstCall = mockWriteFile.mock.calls[0]!;
    const writtenContent = firstCall[1] as string;
    expect(writtenContent).toContain(
      'import { defineRulesConfig } from "@itz4blitz/ai-tools/rules"',
    );
    expect(writtenContent).toContain("defineRulesConfig");
    expect(writtenContent).toContain("rules:");
    expect(writtenContent).toContain("TypeScript Standards");
  });
});

describe("run() - detect command", () => {
  it("shows detection header", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    mockRegistryList.mockReturnValue([]);
    await run(["detect"]);
    expect(allLog()).toContain("Detecting AI coding tools...");
  });

  it("lists detected and undetected tools", async () => {
    const detected = makeAdapter({ id: "claude-code", name: "Claude Code" });
    const missing = makeAdapter({ id: "cursor", name: "Cursor" });

    mockRegistryDetectAll.mockResolvedValue([detected]);
    mockRegistryList.mockReturnValue(["claude-code", "cursor"]);
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return detected;
      if (id === "cursor") return missing;
      return undefined;
    });

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
    mockRegistryList.mockReturnValue(["claude-code", "cursor", "codex"]);
    mockRegistryGet.mockReturnValue(adapter);

    await run(["detect"]);
    expect(allLog()).toContain("Detected 1/3 tools");
  });

  it("skips adapters that registry.get returns undefined for", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    mockRegistryList.mockReturnValue(["ghost-adapter"]);
    mockRegistryGet.mockReturnValue(undefined);

    await run(["detect"]);
    const output = allLog();
    expect(output).toContain("Detected 0/1 tools");
  });

  it("shows configDir for each adapter", async () => {
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      configDir: ".claude/rules",
    });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    mockRegistryList.mockReturnValue(["claude-code"]);
    mockRegistryGet.mockReturnValue(adapter);

    await run(["detect"]);
    expect(allLog()).toContain(".claude/rules");
  });
});

describe("run() - generate command", () => {
  it("prints message when no tools detected (no --tools, detectAll empty)", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["generate"]);
    expect(allLog()).toContain("No tools specified");
  });

  it("generates for adapters resolved via --tools flag", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["generate", "--tools=claude-code"]);
    expect(allLog()).toContain("Generating rules for 1 tool(s)");
    expect(adapter.generate).toHaveBeenCalled();
  });

  it("generates for all detected adapters when no --tools flag", async () => {
    const adapter1 = makeAdapter({ id: "claude-code", name: "Claude Code" });
    const adapter2 = makeAdapter({ id: "cursor", name: "Cursor" });
    mockRegistryDetectAll.mockResolvedValue([adapter1, adapter2]);

    await run(["generate"]);
    expect(allLog()).toContain("Generating rules for 2 tool(s)");
    expect(adapter1.generate).toHaveBeenCalled();
    expect(adapter2.generate).toHaveBeenCalled();
  });

  it("warns for unknown adapter IDs in --tools flag", async () => {
    mockRegistryGet.mockReturnValue(undefined);

    await run(["generate", "--tools=nonexistent"]);
    expect(allWarn()).toContain('Warning: Unknown adapter "nonexistent"');
    expect(allLog()).toContain("No tools specified");
  });

  it("handles mixed known and unknown tools in --tools flag", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["generate", "--tools=claude-code,nonexistent"]);
    expect(allWarn()).toContain('Warning: Unknown adapter "nonexistent"');
    expect(allLog()).toContain("Generating rules for 1 tool(s)");
  });
});

describe("run() - install command", () => {
  it("prints message when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["install"]);
    expect(allLog()).toContain("No tools specified");
  });

  it("installs rules into tools resolved via --tools flag", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["install", "--tools=claude-code"]);
    expect(allLog()).toContain("Installing rules into 1 tool(s)");
    expect(allLog()).toContain("\u2713 Claude Code");
  });

  it("installs for all detected adapters when no --tools flag", async () => {
    const adapter1 = makeAdapter({ id: "claude-code", name: "Claude Code" });
    const adapter2 = makeAdapter({ id: "cursor", name: "Cursor" });
    mockRegistryDetectAll.mockResolvedValue([adapter1, adapter2]);

    await run(["install"]);
    expect(allLog()).toContain("Installing rules into 2 tool(s)");
    expect(allLog()).toContain("\u2713 Claude Code");
    expect(allLog()).toContain("\u2713 Cursor");
  });
});

describe("run() - install guard", () => {
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
    expect(allLog()).toContain("No tools specified");
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
    expect(allLog()).toContain("Installing rules into 1 tool(s)");
  });
});

describe("run() - import command", () => {
  it("prompts for --from when not specified", async () => {
    await run(["import"]);
    expect(allLog()).toContain("Specify source tool with --from");
  });

  it("shows error for unknown --from tool", async () => {
    mockRegistryGet.mockReturnValue(undefined);
    await run(["import", "--from=nonexistent"]);
    expect(allError()).toContain("Unknown tool: nonexistent");
  });

  it("imports rules from specified tool", async () => {
    const importFn = vi.fn<() => Promise<RuleDefinition[]>>().mockResolvedValue([
      { id: "ts", name: "TypeScript", content: "Use strict TS", scope: { type: "always" } },
      { id: "test", name: "Testing", content: "Write tests", scope: { type: "always" } },
    ]);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["import", "--from=claude-code"]);
    expect(importFn).toHaveBeenCalled();
    expect(allLog()).toContain("Imported 2 rule(s) from Claude Code");
    expect(allLog()).toContain("TypeScript (ts)");
    expect(allLog()).toContain("Testing (test)");
  });

  it("shows zero count when no rules found", async () => {
    const importFn = vi.fn<() => Promise<RuleDefinition[]>>().mockResolvedValue([]);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["import", "--from=claude-code"]);
    expect(allLog()).toContain("Imported 0 rule(s) from Claude Code");
  });
});

describe("run() - export command", () => {
  it("prompts for --from when not specified", async () => {
    await run(["export"]);
    expect(allLog()).toContain("Specify source tool with --from");
  });

  it("shows error for unknown --from tool", async () => {
    mockRegistryGet.mockReturnValue(undefined);
    await run(["export", "--from=nonexistent"]);
    expect(allError()).toContain("Unknown tool: nonexistent");
  });

  it("exports rules as JSON to stdout", async () => {
    const rules: RuleDefinition[] = [
      { id: "ts", name: "TypeScript", content: "Use strict TS", scope: { type: "always" } },
    ];
    const importFn = vi.fn<() => Promise<RuleDefinition[]>>().mockResolvedValue(rules);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["export", "--from=claude-code"]);
    const output = allLog();
    expect(output).toContain('"id": "ts"');
    expect(output).toContain('"name": "TypeScript"');
    expect(output).toContain('"content": "Use strict TS"');
  });
});

describe("run() - sync command", () => {
  it("prompts for --from when not specified", async () => {
    await run(["sync"]);
    expect(allLog()).toContain("Specify source tool with --from");
  });

  it("shows error for unknown --from tool", async () => {
    mockRegistryGet.mockReturnValue(undefined);
    await run(["sync", "--from=nonexistent"]);
    expect(allError()).toContain("Unknown tool: nonexistent");
  });

  it("syncs rules from source to targets", async () => {
    const rules: RuleDefinition[] = [
      { id: "ts", name: "TypeScript", content: "Use strict TS", scope: { type: "always" } },
    ];
    const importFn = vi.fn<() => Promise<RuleDefinition[]>>().mockResolvedValue(rules);
    const installFn = vi
      .fn<(files: GeneratedFile[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const generateFn = vi
      .fn<(rules: RuleDefinition[]) => Promise<GeneratedFile[]>>()
      .mockResolvedValue([{ path: ".cursor/rules/ts.md", content: "# TS", format: "md" }]);

    const source = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });
    const target = makeAdapter({
      id: "cursor",
      name: "Cursor",
      generate: generateFn,
      install: installFn,
    });

    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return source;
      if (id === "cursor") return target;
      return undefined;
    });
    mockRegistryDetectAll.mockResolvedValue([source, target]);

    await run(["sync", "--from=claude-code"]);
    expect(importFn).toHaveBeenCalled();
    expect(generateFn).toHaveBeenCalledWith(rules);
    expect(installFn).toHaveBeenCalled();
    expect(allLog()).toContain("Imported 1 rule(s) from Claude Code");
    expect(allLog()).toContain("\u2713 Cursor (1 files)");
  });

  it("respects --dry-run during sync", async () => {
    const rules: RuleDefinition[] = [
      { id: "ts", name: "TypeScript", content: "Use strict TS", scope: { type: "always" } },
    ];
    const importFn = vi.fn<() => Promise<RuleDefinition[]>>().mockResolvedValue(rules);
    const installFn = vi
      .fn<(files: GeneratedFile[]) => Promise<void>>()
      .mockResolvedValue(undefined);
    const generateFn = vi
      .fn<(rules: RuleDefinition[]) => Promise<GeneratedFile[]>>()
      .mockResolvedValue([{ path: ".cursor/rules/ts.md", content: "# TS", format: "md" }]);

    const source = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });
    const target = makeAdapter({
      id: "cursor",
      name: "Cursor",
      generate: generateFn,
      install: installFn,
    });

    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return source;
      if (id === "cursor") return target;
      return undefined;
    });
    mockRegistryDetectAll.mockResolvedValue([source, target]);

    await run(["sync", "--from=claude-code", "--dry-run"]);
    expect(installFn).not.toHaveBeenCalled();
    expect(allLog()).toContain("[dry-run] Cursor: .cursor/rules/ts.md");
  });

  it("excludes source tool from targets during sync", async () => {
    const rules: RuleDefinition[] = [
      { id: "ts", name: "TypeScript", content: "Use strict TS", scope: { type: "always" } },
    ];
    const importFn = vi.fn<() => Promise<RuleDefinition[]>>().mockResolvedValue(rules);
    const sourceInstallFn = vi
      .fn<(files: GeneratedFile[]) => Promise<void>>()
      .mockResolvedValue(undefined);

    const source = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      import: importFn,
      install: sourceInstallFn,
    });

    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return source;
      return undefined;
    });
    // When only source is detected, it should be excluded as a target
    mockRegistryDetectAll.mockResolvedValue([source]);

    await run(["sync", "--from=claude-code"]);
    expect(sourceInstallFn).not.toHaveBeenCalled();
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
  });

  it("parses --from flag with = syntax", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["import", "--from=claude-code"]);
    expect(mockRegistryGet).toHaveBeenCalledWith("claude-code");
  });

  it("parses --dry-run flag", async () => {
    await run(["init", "--dry-run"]);
    expect(allLog()).toContain("[dry-run]");
    expect(mockWriteFile).not.toHaveBeenCalled();
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
    expect(allLog()).toContain("Generating rules for 2 tool(s)");
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
    expect(allLog()).toContain("Generating rules for 1 tool(s)");
  });

  it("trims whitespace in --tools values", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["generate", "--tools= claude-code "]);
    expect(allLog()).toContain("Generating rules for 1 tool(s)");
  });
});

describe("run() - error propagation", () => {
  it("propagates adapter import errors", async () => {
    const adapter = makeAdapter({
      id: "broken",
      name: "Broken",
      import: vi
        .fn<() => Promise<RuleDefinition[]>>()
        .mockRejectedValue(new Error("import failed")),
    });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "broken") return adapter;
      return undefined;
    });

    await expect(run(["import", "--from=broken"])).rejects.toThrow("import failed");
  });

  it("propagates adapter generate errors during sync", async () => {
    const rules: RuleDefinition[] = [
      { id: "ts", name: "TypeScript", content: "Use strict TS", scope: { type: "always" } },
    ];
    const importFn = vi.fn<() => Promise<RuleDefinition[]>>().mockResolvedValue(rules);
    const source = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });
    const target = makeAdapter({
      id: "cursor",
      name: "Cursor",
      generate: vi
        .fn<(rules: RuleDefinition[]) => Promise<GeneratedFile[]>>()
        .mockRejectedValue(new Error("generate failed")),
    });

    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return source;
      if (id === "cursor") return target;
      return undefined;
    });
    mockRegistryDetectAll.mockResolvedValue([source, target]);

    await expect(run(["sync", "--from=claude-code"])).rejects.toThrow("generate failed");
  });
});
