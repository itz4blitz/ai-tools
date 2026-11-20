import { describe, it, expect, vi } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({ pid: 1234 })),
}));

import { spawn } from "node:child_process";
import { buildHandoffCommand, launchWithContext, spawnTool } from "./resume.js";
import type { SessionContext } from "../types/index.js";

function makeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: "sess-123",
    tool: "claude",
    title: "Fix bug",
    summary: "Working on bug fix.",
    keyFiles: [],
    keyDecisions: [],
    lastActivity: "2025-01-01T12:00:00Z",
    handoffMarkdown: "",
    ...overrides,
  };
}

describe("buildHandoffCommand", () => {
  it("passes handoff prompt positionally for claude and claude-code", () => {
    expect(buildHandoffCommand("claude", "# Handoff")).toEqual({
      command: "claude",
      args: ["# Handoff"],
    });
    expect(buildHandoffCommand("claude-code", "# Handoff")).toEqual({
      command: "claude",
      args: ["# Handoff"],
    });
  });

  it("passes handoff prompt positionally for codex", () => {
    expect(buildHandoffCommand("codex", "# Handoff")).toEqual({
      command: "codex",
      args: ["# Handoff"],
    });
  });

  it("passes -i flag for gemini and gemini-cli", () => {
    expect(buildHandoffCommand("gemini", "# Handoff")).toEqual({
      command: "gemini",
      args: ["-i", "# Handoff"],
    });
    expect(buildHandoffCommand("gemini-cli", "# Handoff")).toEqual({
      command: "gemini",
      args: ["-i", "# Handoff"],
    });
  });

  it("passes --prompt flag for opencode", () => {
    expect(buildHandoffCommand("opencode", "# Handoff")).toEqual({
      command: "opencode",
      args: ["--prompt", "# Handoff"],
    });
  });

  it("returns null for unknown tools", () => {
    expect(buildHandoffCommand("unknown", "# Handoff")).toBeNull();
  });
});

describe("launchWithContext", () => {
  it("passes positional markdown arg for claude and claude-code", () => {
    const ctx = makeContext({ tool: "claude" });
    const result = launchWithContext("claude", ctx);
    expect(result).not.toBeNull();
    expect(result?.command).toBe("claude");
    expect(result?.args).toHaveLength(1);
    expect(result?.args[0]).toContain("Session Handoff");

    const aliasResult = launchWithContext("claude-code", ctx);
    expect(aliasResult).toEqual(result);
  });

  it("passes positional markdown arg for codex", () => {
    const ctx = makeContext({ tool: "codex" });
    const result = launchWithContext("codex", ctx);
    expect(result).not.toBeNull();
    expect(result?.command).toBe("codex");
    expect(result?.args).toHaveLength(1);
    expect(result?.args[0]).toContain("Session Handoff");
  });

  it("passes -i flag for gemini and gemini-cli", () => {
    const ctx = makeContext({ tool: "gemini" });
    const result = launchWithContext("gemini", ctx);
    expect(result).not.toBeNull();
    expect(result?.command).toBe("gemini");
    expect(result?.args[0]).toBe("-i");
    expect(result?.args[1]).toContain("Session Handoff");

    const aliasResult = launchWithContext("gemini-cli", ctx);
    expect(aliasResult).toEqual(result);
  });

  it("passes --prompt flag for opencode", () => {
    const ctx = makeContext({ tool: "opencode" });
    const result = launchWithContext("opencode", ctx);
    expect(result).not.toBeNull();
    expect(result?.command).toBe("opencode");
    expect(result?.args[0]).toBe("--prompt");
    expect(result?.args[1]).toContain("Session Handoff");
  });

  it("returns null for unknown tools", () => {
    const ctx = makeContext({ tool: "unknown" });
    const result = launchWithContext("unknown", ctx);
    expect(result).toBeNull();
  });

  it("returns null for copilot (not in HANDOFF_TARGETS)", () => {
    const ctx = makeContext({ tool: "copilot" });
    const result = launchWithContext("copilot", ctx);
    expect(result).toBeNull();
  });
});

describe("spawnTool", () => {
  it("calls spawn with correct arguments and platform shell flag", () => {
    spawnTool("claude", ["hello"]);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith("claude", ["hello"], {
      stdio: "inherit",
      cwd: undefined,
      shell: process.platform === "win32",
    });
  });

  it("passes cwd option", () => {
    spawnTool("codex", [], { cwd: "/my/project" });
    expect(vi.mocked(spawn)).toHaveBeenCalledWith("codex", [], {
      stdio: "inherit",
      cwd: "/my/project",
      shell: process.platform === "win32",
    });
  });

  it("disables shell when args contain multiline content or cmd.exe metacharacters", () => {
    spawnTool("claude", ["# Handoff\nline2 & calc"]);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith("claude", ["# Handoff\nline2 & calc"], {
      stdio: "inherit",
      cwd: undefined,
      shell: false,
    });
  });
});
