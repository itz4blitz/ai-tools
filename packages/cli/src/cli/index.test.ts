import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockHooksRun = vi.fn();
const mockMcpRun = vi.fn();
const mockSkillsRun = vi.fn();
const mockAgentsRun = vi.fn();
const mockRulesRun = vi.fn();
const mockPluginsRun = vi.fn();
const mockSessionsRun = vi.fn();
const mockUiRun = vi.fn();

vi.mock("@itz4blitz/ai-tools-hooks/cli", () => ({ run: mockHooksRun }));
vi.mock("@itz4blitz/ai-tools-mcp/cli", () => ({ run: mockMcpRun }));
vi.mock("@itz4blitz/ai-tools-skills/cli", () => ({ run: mockSkillsRun }));
vi.mock("@itz4blitz/ai-tools-agents/cli", () => ({ run: mockAgentsRun }));
vi.mock("@itz4blitz/ai-tools-rules/cli", () => ({ run: mockRulesRun }));
vi.mock("../plugins/cli.js", () => ({ run: mockPluginsRun }));
vi.mock("@itz4blitz/ai-tools-sessions/cli", () => ({ run: mockSessionsRun }));
vi.mock("@itz4blitz/ai-tools-tui/cli", () => ({ run: mockUiRun }));

import { run } from "./index.js";

let logOutput: string[];
let errorOutput: string[];
let exitCode: number | undefined;

const originalLog = console.log;
const originalError = console.error;
const originalExit = process.exit;

beforeEach(() => {
  logOutput = [];
  errorOutput = [];
  exitCode = undefined;

  console.log = vi.fn((...args: unknown[]) => {
    logOutput.push(args.map(String).join(" "));
  });
  console.error = vi.fn((...args: unknown[]) => {
    errorOutput.push(args.map(String).join(" "));
  });
  process.exit = vi.fn((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as never;

  vi.clearAllMocks();
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exit = originalExit;
});

function allLog(): string {
  return logOutput.join("\n");
}

function allError(): string {
  return errorOutput.join("\n");
}

// ── Help output ──────────────────────────────────────────────

describe("run() - help output", () => {
  it("prints help text for 'help' command", async () => {
    await run(["help"]);
    expect(allLog()).toContain("ai-tools - Unified CLI");
    expect(allLog()).toContain("USAGE:");
    expect(allLog()).toContain("ENGINES:");
    expect(allLog()).toContain("CROSS-CUTTING COMMANDS:");
    expect(allLog()).toContain("EXAMPLES:");
  });

  it("prints help text for --help flag", async () => {
    await run(["--help"]);
    expect(allLog()).toContain("ai-tools - Unified CLI");
  });

  it("prints help text for -h flag", async () => {
    await run(["-h"]);
    expect(allLog()).toContain("ai-tools - Unified CLI");
  });

  it("prints help text when no arguments are provided", async () => {
    await run([]);
    expect(allLog()).toContain("ai-tools - Unified CLI");
  });

  it("includes all engine names in help text", async () => {
    await run(["help"]);
    const output = allLog();
    for (const name of ["hooks", "mcp", "skills", "agents", "rules", "plugins", "sessions"]) {
      expect(output).toContain(name);
    }
  });

  it("does not advertise unified sync as a cross-cutting command", async () => {
    await run(["help"]);
    const output = allLog();
    const crossCutting = output.split("CROSS-CUTTING COMMANDS:")[1]?.split("INTERACTIVE:")[0] ?? "";
    expect(crossCutting).toContain("detect");
    expect(crossCutting).not.toMatch(/\bsync\b/);
    expect(output).toContain("ai-tools mcp install --layer=project");
    expect(output).toContain("ai-tools mcp sync --layer=project");
    expect(output).not.toMatch(new RegExp(["Palam", "Health"].join("")));
  });

  it("does not claim canonical install uses a CanonicalStore", async () => {
    await run(["help"]);
    const output = allLog();
    expect(output).not.toMatch(/canonical store/i);
    expect(output).toContain("Install engine configs into detected tool directories");
  });
});

// ── Unknown command ──────────────────────────────────────────

describe("run() - unknown command", () => {
  it("prints error and help, then exits with code 1", async () => {
    await expect(run(["foobar"])).rejects.toThrow("process.exit(1)");
    expect(allError()).toContain("Unknown command: foobar");
    expect(allLog()).toContain("USAGE:");
    expect(exitCode).toBe(1);
  });
});

// ── Engine delegation ────────────────────────────────────────

describe("run() - engine delegation", () => {
  it("delegates to hooks engine", async () => {
    await run(["hooks", "detect"]);
    expect(mockHooksRun).toHaveBeenCalledWith(["detect"]);
  });

  it("delegates to mcp engine", async () => {
    await run(["mcp", "install"]);
    expect(mockMcpRun).toHaveBeenCalledWith(["install"]);
  });

  it("delegates to skills engine", async () => {
    await run(["skills", "sync"]);
    expect(mockSkillsRun).toHaveBeenCalledWith(["sync"]);
  });

  it("delegates to agents engine", async () => {
    await run(["agents", "export"]);
    expect(mockAgentsRun).toHaveBeenCalledWith(["export"]);
  });

  it("delegates to rules engine", async () => {
    await run(["rules", "import"]);
    expect(mockRulesRun).toHaveBeenCalledWith(["import"]);
  });

  it("delegates to plugins engine", async () => {
    await run(["plugins", "plan"]);
    expect(mockPluginsRun).toHaveBeenCalledWith(["plan"]);
  });

  it("delegates to sessions engine", async () => {
    await run(["sessions", "list"]);
    expect(mockSessionsRun).toHaveBeenCalledWith(["list"]);
  });

  it("forwards all remaining args to the engine", async () => {
    await run(["mcp", "install", "--tools=claude-code", "--dry-run"]);
    expect(mockMcpRun).toHaveBeenCalledWith(["install", "--tools=claude-code", "--dry-run"]);
  });
});

// ── UI delegation ───────────────────────────────────────────

describe("run() - ui delegation", () => {
  it("delegates to ui package", async () => {
    await run(["ui"]);
    expect(mockUiRun).toHaveBeenCalledWith([]);
  });

  it("forwards flags to ui package", async () => {
    await run(["ui", "--no-pty"]);
    expect(mockUiRun).toHaveBeenCalledWith(["--no-pty"]);
  });
});

// ── Cross-cutting detect ─────────────────────────────────────

describe("run() - cross-cutting detect", () => {
  it("calls detect on all 7 engines", async () => {
    await run(["detect"]);

    expect(mockHooksRun).toHaveBeenCalledWith(["detect"]);
    expect(mockMcpRun).toHaveBeenCalledWith(["detect"]);
    expect(mockSkillsRun).toHaveBeenCalledWith(["detect"]);
    expect(mockAgentsRun).toHaveBeenCalledWith(["detect"]);
    expect(mockRulesRun).toHaveBeenCalledWith(["detect"]);
    expect(mockPluginsRun).toHaveBeenCalledWith(["detect"]);
    expect(mockSessionsRun).toHaveBeenCalledWith(["detect"]);
  });

  it("prints engine headers", async () => {
    await run(["detect"]);
    const output = allLog();
    expect(output).toContain("── hooks ──");
    expect(output).toContain("── mcp ──");
    expect(output).toContain("── skills ──");
    expect(output).toContain("── agents ──");
    expect(output).toContain("── rules ──");
    expect(output).toContain("── plugins ──");
    expect(output).toContain("── sessions ──");
  });

  it("forwards flags to each engine", async () => {
    await run(["detect", "--tools=claude-code"]);

    expect(mockHooksRun).toHaveBeenCalledWith(["detect", "--tools=claude-code"]);
    expect(mockMcpRun).toHaveBeenCalledWith(["detect", "--tools=claude-code"]);
    expect(mockPluginsRun).toHaveBeenCalledWith(["detect", "--tools=claude-code"]);
  });

  it("catches engine errors and continues", async () => {
    mockHooksRun.mockRejectedValueOnce(new Error("hooks failed"));

    await run(["detect"]);

    expect(allError()).toContain("Error: hooks failed");
    // Other engines still called
    expect(mockMcpRun).toHaveBeenCalledWith(["detect"]);
    expect(mockSkillsRun).toHaveBeenCalledWith(["detect"]);
    expect(mockAgentsRun).toHaveBeenCalledWith(["detect"]);
    expect(mockRulesRun).toHaveBeenCalledWith(["detect"]);
    expect(mockPluginsRun).toHaveBeenCalledWith(["detect"]);
    expect(mockSessionsRun).toHaveBeenCalledWith(["detect"]);
  });
});

// ── Cross-cutting sync ───────────────────────────────────────

describe("run() - unified sync is decommissioned", () => {
  it("refuses unified sync instead of union-copying across engines", async () => {
    await expect(run(["sync"])).rejects.toThrow("process.exit(1)");

    expect(allError()).toBe(
      [
        "Unified sync is disabled. It used to copy imported servers between every tool.",
        "Use `ai-tools mcp sync` to install from mcp.config.ts (never copies imports; honors --layer).",
      ].join("\n"),
    );
    expect(exitCode).toBe(1);
    expect(mockHooksRun).not.toHaveBeenCalled();
    expect(mockMcpRun).not.toHaveBeenCalled();
    expect(mockSkillsRun).not.toHaveBeenCalled();
    expect(mockAgentsRun).not.toHaveBeenCalled();
    expect(mockRulesRun).not.toHaveBeenCalled();
    expect(mockPluginsRun).not.toHaveBeenCalled();
    expect(mockSessionsRun).not.toHaveBeenCalled();
  });

  it("refuses unified sync even with --dry-run", async () => {
    await expect(run(["sync", "--dry-run"])).rejects.toThrow("process.exit(1)");
    expect(allError()).toContain("Unified sync is disabled");
    expect(mockMcpRun).not.toHaveBeenCalled();
    expect(mockSkillsRun).not.toHaveBeenCalled();
    expect(mockAgentsRun).not.toHaveBeenCalled();
    expect(mockRulesRun).not.toHaveBeenCalled();
  });

  it("still delegates engine-level mcp sync (config-scoped) to the mcp engine", async () => {
    await run(["mcp", "sync", "--layer=project", "--dry-run"]);
    expect(mockMcpRun).toHaveBeenCalledTimes(1);
    expect(mockMcpRun).toHaveBeenCalledWith(["sync", "--layer=project", "--dry-run"]);
    expect(mockSkillsRun).not.toHaveBeenCalled();
    expect(mockAgentsRun).not.toHaveBeenCalled();
    expect(mockRulesRun).not.toHaveBeenCalled();
  });
});

// ── Flag pass-through ────────────────────────────────────────

describe("run() - flag pass-through", () => {
  it("passes --tools flag through to engine", async () => {
    await run(["mcp", "generate", "--tools=cursor,claude-code"]);
    expect(mockMcpRun).toHaveBeenCalledWith(["generate", "--tools=cursor,claude-code"]);
  });

  it("passes --dry-run flag through to engine", async () => {
    await run(["rules", "sync", "--dry-run"]);
    expect(mockRulesRun).toHaveBeenCalledWith(["sync", "--dry-run"]);
  });

  it("passes multiple flags through to engine", async () => {
    await run(["skills", "install", "--tools=claude-code", "--dry-run"]);
    expect(mockSkillsRun).toHaveBeenCalledWith(["install", "--tools=claude-code", "--dry-run"]);
  });
});
