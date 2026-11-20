import { describe, it, expect } from "vitest";
import { switchTool, getToolDefinitions } from "./switch-tool.js";
import type { PaneState } from "../types.js";

// -- switchTool --

describe("switchTool()", () => {
  it("returns focus action when pane already exists", () => {
    const panes: PaneState[] = [
      { toolId: "claude", active: true, pid: 123 },
      { toolId: "codex", active: false, pid: 456 },
    ];

    const result = switchTool("codex", panes);
    expect(result?.action).toBe("focus");
    expect(result?.paneIndex).toBe(1);
    expect(result?.toolId).toBe("codex");
  });

  it("returns spawn action when no pane exists", () => {
    const panes: PaneState[] = [{ toolId: "claude", active: true, pid: 123 }];

    const result = switchTool("codex", panes);
    expect(result?.action).toBe("spawn");
    expect(result?.paneIndex).toBe(1);
    expect(result?.toolId).toBe("codex");
    expect(result?.command).toBe("codex");
    expect(result?.args).toEqual([]);
  });

  it("returns null for unknown tool", () => {
    const result = switchTool("nonexistent", []);
    expect(result).toBeNull();
  });

  it("returns correct pane index for spawn with empty panes", () => {
    const result = switchTool("claude", []);
    expect(result?.paneIndex).toBe(0);
    expect(result?.action).toBe("spawn");
  });

  it("returns focus on first matching pane when multiple exist", () => {
    const panes: PaneState[] = [
      { toolId: "claude", active: false },
      { toolId: "claude", active: true },
    ];

    const result = switchTool("claude", panes);
    expect(result?.action).toBe("focus");
    expect(result?.paneIndex).toBe(0);
  });

  it("returns copilot with gh command and copilot args", () => {
    const result = switchTool("copilot", []);
    expect(result?.command).toBe("gh");
    expect(result?.args).toEqual(["copilot"]);
  });

  it("returns droid with correct command", () => {
    const result = switchTool("droid", []);
    expect(result?.command).toBe("droid");
  });

  it("resolves canonical tool ID aliases (claude-code, gemini-cli)", () => {
    const spawnClaude = switchTool("claude-code", []);
    expect(spawnClaude?.action).toBe("spawn");
    expect(spawnClaude?.command).toBe("claude");

    const spawnGemini = switchTool("gemini-cli", []);
    expect(spawnGemini?.action).toBe("spawn");
    expect(spawnGemini?.command).toBe("gemini");

    const focusExisting = switchTool("claude-code", [{ toolId: "claude", active: true }]);
    expect(focusExisting?.action).toBe("focus");
    expect(focusExisting?.paneIndex).toBe(0);
  });
});

// -- getToolDefinitions --

describe("getToolDefinitions()", () => {
  it("returns all tool definitions", () => {
    const defs = getToolDefinitions();
    expect(Object.keys(defs).length).toBeGreaterThan(0);
    expect(defs["claude"]).toBeDefined();
    expect(defs["codex"]).toBeDefined();
    expect(defs["gemini"]).toBeDefined();
  });

  it("each definition has name, command, and args", () => {
    const defs = getToolDefinitions();
    for (const [id, def] of Object.entries(defs)) {
      void id;
      expect(def.name).toBeTruthy();
      expect(def.command).toBeTruthy();
      expect(Array.isArray(def.args)).toBe(true);
    }
  });

  it("returns a copy (not a reference)", () => {
    const a = getToolDefinitions();
    const b = getToolDefinitions();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
