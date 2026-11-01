import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks ──────────────────────────────────────────

const { mockRegistryDetectAll, mockRegistryList, mockRegistryGet, mockWriteFile, mockExistsSync } =
  vi.hoisted(() => ({
    mockRegistryDetectAll: vi.fn(),
    mockRegistryList: vi.fn(),
    mockRegistryGet: vi.fn(),
    mockWriteFile: vi.fn(),
    mockExistsSync: vi.fn(),
  }));

// ── Mock adapter self-registration ──────────────────────────

vi.mock("../adapters/all.js", () => ({}));

// ── Mock registry ───────────────────────────────────────────

vi.mock("../adapters/registry.js", () => ({
  registry: {
    detectAll: (...args: unknown[]) => mockRegistryDetectAll(...args),
    list: () => mockRegistryList(),
    get: (id: string) => mockRegistryGet(id),
  },
}));

// ── Mock node:fs ────────────────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

// ── Mock node:fs/promises ───────────────────────────────────

vi.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: vi.fn(),
}));

// ── Import under test ───────────────────────────────────────

import { homedir } from "node:os";
import { run } from "./index.js";
import type { BaseSkillAdapter } from "../adapters/base.js";
import type { SkillDefinition, GeneratedFile } from "../types/index.js";

// ── Mock adapter factory ────────────────────────────────────

function makeAdapter(overrides: Partial<BaseSkillAdapter> = {}): BaseSkillAdapter {
  return {
    id: overrides.id ?? "test-tool",
    name: overrides.name ?? "Test Tool",
    nativeSupport: overrides.nativeSupport ?? true,
    configDir: overrides.configDir ?? ".test/prompts",
    detect: overrides.detect ?? vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    generate:
      overrides.generate ??
      vi
        .fn<(skills: SkillDefinition[]) => Promise<GeneratedFile[]>>()
        .mockResolvedValue([
          { path: ".test/prompts/skill.md", content: "# Skill\n\nContent\n", format: "md" },
        ]),
    install:
      overrides.install ??
      vi.fn<(files: GeneratedFile[]) => Promise<void>>().mockResolvedValue(undefined),
    import: overrides.import ?? vi.fn<() => Promise<SkillDefinition[]>>().mockResolvedValue([]),
    uninstall: overrides.uninstall ?? vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as BaseSkillAdapter;
}

// ── Console / process mocks ─────────────────────────────────

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
  mockExistsSync.mockReturnValue(false);
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  process.exit = originalExit;
});

// ── Helpers ─────────────────────────────────────────────────

function allLog(): string {
  return logOutput.join("\n");
}

function allError(): string {
  return errorOutput.join("\n");
}

// ── Tests ───────────────────────────────────────────────────

describe("run() - help output", () => {
  it('prints help text for "help" command', async () => {
    await run(["help"]);
    expect(allLog()).toContain("ai-skills - Universal skills/prompts configuration");
    expect(allLog()).toContain("USAGE:");
    expect(allLog()).toContain("COMMANDS:");
  });

  it("prints help text for --help flag", async () => {
    await run(["--help"]);
    expect(allLog()).toContain("ai-skills - Universal skills/prompts configuration");
  });

  it("prints help text for -h flag", async () => {
    await run(["-h"]);
    expect(allLog()).toContain("ai-skills - Universal skills/prompts configuration");
  });

  it("prints help text when no arguments are provided", async () => {
    await run([]);
    expect(allLog()).toContain("ai-skills - Universal skills/prompts configuration");
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
});

describe("run() - init command", () => {
  it("skips when config already exists", async () => {
    mockExistsSync.mockReturnValue(true);
    await run(["init"]);
    expect(allLog()).toContain("Config already exists: ai-skills.config.ts");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("creates config file when none exists", async () => {
    mockExistsSync.mockReturnValue(false);
    await run(["init"]);
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(mockWriteFile).toHaveBeenCalledWith(
      "ai-skills.config.ts",
      expect.stringContaining("defineConfig"),
      "utf-8",
    );
    expect(allLog()).toContain("Created ai-skills.config.ts");
    expect(allLog()).toContain("Next steps:");
  });

  it("respects --dry-run flag and does not write files", async () => {
    mockExistsSync.mockReturnValue(false);
    await run(["init", "--dry-run"]);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(allLog()).toContain("[dry-run] Would create ai-skills.config.ts");
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
});

describe("run() - generate command", () => {
  it("prints message when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["generate"]);
    expect(allLog()).toContain("No AI tools detected");
  });

  it("warns for unknown adapter IDs in --tools flag", async () => {
    mockRegistryGet.mockReturnValue(undefined);
    await run(["generate"]);
    expect(allLog()).toContain("No AI tools detected");
  });
});

describe("run() - install command", () => {
  it("prints message when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["install"]);
    expect(allLog()).toContain("No AI tools detected");
  });
});

describe("run() - import command", () => {
  it("prints message when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["import"]);
    expect(allLog()).toContain("No AI tools detected");
  });

  it("imports skills from specified tool", async () => {
    const importFn = vi
      .fn<() => Promise<SkillDefinition[]>>()
      .mockResolvedValue([{ id: "review", name: "Code Review", content: "Review the code" }]);
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code", import: importFn });

    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["import", "--tools=claude-code"]);
    expect(importFn).toHaveBeenCalled();
    expect(allLog()).toContain("Imported 1 skill(s) from Claude Code");
    expect(allLog()).toContain("Code Review (review)");
  });
});

describe("run() - sync command", () => {
  it("prints message when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["sync"]);
    expect(allLog()).toContain("No AI tools detected");
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
    expect(allLog()).toContain("Installing skills into 1 tool(s)");
  });
});

describe("run() - flag parsing", () => {
  it("parses --tools flag with = syntax", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["import", "--tools=claude-code"]);
    expect(mockRegistryGet).toHaveBeenCalledWith("claude-code");
    expect(mockRegistryDetectAll).not.toHaveBeenCalled();
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
    expect(allLog()).toContain("Generating skills for 1 tool(s)");
  });

  it("--layer=user generates for the user layer and installs under the home directory", async () => {
    const generateFn = vi
      .fn<(skills: SkillDefinition[], layer?: string) => Promise<GeneratedFile[]>>()
      .mockResolvedValue([]);
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const detectFn = vi.fn<(cwd?: string) => Promise<boolean>>().mockResolvedValue(true);
    const adapter = makeAdapter({
      id: "codex",
      detect: detectFn,
      generate: generateFn,
      install: installFn,
    });
    mockRegistryGet.mockImplementation((id: string) => (id === "codex" ? adapter : undefined));

    await run(["install", "--tools=codex", "--layer=user"]);

    expect(detectFn).toHaveBeenCalledWith(homedir());
    expect(generateFn).toHaveBeenCalledWith([], "user");
    expect(installFn).toHaveBeenCalledWith([], homedir());
  });

  it("detects against the home directory for --layer=user without --tools", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["install", "--layer=user"]);
    expect(mockRegistryDetectAll).toHaveBeenCalledWith(homedir());
  });

  it("rejects an unknown --layer value", async () => {
    await expect(run(["install", "--layer=global"])).rejects.toThrow('Invalid --layer "global"');
  });
});
