import { describe, it, expect } from "vitest";
import { getAvailableTools, getToolCommand, formatToolList } from "./tool-launcher.js";
import type { ToolInfo } from "../types.js";

// -- getAvailableTools --

describe("getAvailableTools()", () => {
  it("returns all static tools as not-installed when no detected tools", () => {
    const tools = getAvailableTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.status === "not-installed")).toBe(true);
  });

  it("returns all static tools when passed empty array", () => {
    const tools = getAvailableTools([]);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.some((t) => t.id === "claude")).toBe(true);
    expect(tools.some((t) => t.id === "codex")).toBe(true);
    expect(tools.some((t) => t.id === "gemini")).toBe(true);
  });

  it("uses detected tool data when available", () => {
    const detected: ToolInfo[] = [
      {
        id: "claude",
        name: "Claude Code",
        command: "claude",
        status: "available",
        sessionCount: 5,
      },
    ];

    const tools = getAvailableTools(detected);
    const claude = tools.find((t) => t.id === "claude");
    expect(claude?.status).toBe("available");
    expect(claude?.sessionCount).toBe(5);
  });

  it("merges detected and static tools without duplicates", () => {
    const detected: ToolInfo[] = [
      {
        id: "claude",
        name: "Claude Code",
        command: "claude",
        status: "running",
        sessionCount: 2,
      },
    ];

    const tools = getAvailableTools(detected);
    const claudeEntries = tools.filter((t) => t.id === "claude");
    expect(claudeEntries).toHaveLength(1);
    expect(claudeEntries[0]?.status).toBe("running");
  });

  it("includes unknown detected tools not in static definitions", () => {
    const detected: ToolInfo[] = [
      {
        id: "custom-tool",
        name: "Custom Tool",
        command: "custom",
        status: "available",
        sessionCount: 0,
      },
    ];

    const tools = getAvailableTools(detected);
    expect(tools.some((t) => t.id === "custom-tool")).toBe(true);
  });

  it("deduplicates canonical aliases (claude-code / gemini-cli) against static definitions", () => {
    const detected: ToolInfo[] = [
      {
        id: "claude-code",
        name: "Claude Code",
        command: "claude",
        status: "available",
        sessionCount: 4,
      },
      {
        id: "gemini-cli",
        name: "Gemini CLI",
        command: "gemini",
        status: "available",
        sessionCount: 1,
      },
    ];

    const tools = getAvailableTools(detected);
    expect(tools.filter((t) => t.id === "claude" || t.id === "claude-code")).toHaveLength(1);
    expect(tools.filter((t) => t.id === "gemini" || t.id === "gemini-cli")).toHaveLength(1);
  });
});

// -- getToolCommand --

describe("getToolCommand()", () => {
  it("returns command for known tool", () => {
    expect(getToolCommand("claude")).toBe("claude");
    expect(getToolCommand("claude-code")).toBe("claude");
    expect(getToolCommand("codex")).toBe("codex");
    expect(getToolCommand("gemini")).toBe("gemini");
    expect(getToolCommand("gemini-cli")).toBe("gemini");
  });

  it("returns null for unknown tool", () => {
    expect(getToolCommand("nonexistent")).toBeNull();
  });

  it("returns copilot command", () => {
    expect(getToolCommand("copilot")).toBe("gh copilot");
  });
});

// -- formatToolList --

describe("formatToolList()", () => {
  it("formats tools with status icons", () => {
    const tools: ToolInfo[] = [
      {
        id: "claude",
        name: "Claude Code",
        command: "claude",
        status: "available",
        sessionCount: 3,
      },
      { id: "codex", name: "Codex", command: "codex", status: "not-installed", sessionCount: 0 },
    ];

    const lines = formatToolList(tools);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("\u2713");
    expect(lines[0]).toContain("Claude Code");
    expect(lines[0]).toContain("3 sessions");
    expect(lines[1]).toContain("\u2717");
    expect(lines[1]).toContain("Codex");
  });

  it("formats running tool with play icon", () => {
    const tools: ToolInfo[] = [
      { id: "claude", name: "Claude Code", command: "claude", status: "running", sessionCount: 1 },
    ];

    const lines = formatToolList(tools);
    expect(lines[0]).toContain("\u25B6");
  });

  it("formats stopped tool with stop icon", () => {
    const tools: ToolInfo[] = [
      { id: "codex", name: "Codex", command: "codex", status: "stopped", sessionCount: 0 },
    ];

    const lines = formatToolList(tools);
    expect(lines[0]).toContain("\u25A0");
  });

  it("omits session count when zero", () => {
    const tools: ToolInfo[] = [
      { id: "codex", name: "Codex", command: "codex", status: "available", sessionCount: 0 },
    ];

    const lines = formatToolList(tools);
    expect(lines[0]).not.toContain("sessions");
  });

  it("returns empty array for empty input", () => {
    const lines = formatToolList([]);
    expect(lines).toEqual([]);
  });
});
