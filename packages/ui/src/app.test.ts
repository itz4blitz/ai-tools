import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@itz4blitz/ai-tools-sessions", () => {
  type InternalMockAdapter = {
    id: string;
    name: string;
    command: string;
    detect: () => Promise<boolean>;
    parseSessions: () => Promise<{ id: string }[]>;
  };

  const adapters = new Map<string, InternalMockAdapter>();

  return {
    registry: {
      list: () => [...adapters.keys()],
      get: (id: string) => adapters.get(id),
      register: (adapter: InternalMockAdapter) => adapters.set(adapter.id, adapter),
      clear: () => adapters.clear(),
    },
  };
});

vi.mock("@itz4blitz/ai-tools-sessions/adapters/all", () => ({}));

import {
  createInitialState,
  detectMode,
  detectTools,
  computeConfigHealth,
  getStatusBarData,
} from "./app.js";
import { registry } from "@itz4blitz/ai-tools-sessions";
import type { AppState } from "./types.js";

type MockAdapter = {
  id: string;
  name: string;
  command: string;
  detect: () => Promise<boolean>;
  parseSessions: () => Promise<{ id: string }[]>;
};

function registerMockAdapter(
  id: string,
  opts: { detected?: boolean; sessions?: { id: string }[] } = {},
): void {
  const detected = opts.detected ?? true;
  const sessions = opts.sessions ?? [];
  (registry as unknown as { register: (a: MockAdapter) => void }).register({
    id,
    name: `${id} Tool`,
    command: id,
    detect: async () => detected,
    parseSessions: async () => sessions,
  });
}

beforeEach(() => {
  (registry as unknown as { clear: () => void }).clear();
  vi.clearAllMocks();
});

// -- createInitialState --

describe("createInitialState()", () => {
  it("returns empty state with expected defaults", () => {
    const state = createInitialState();
    expect(state.mode).toBe("unknown");
    expect(state.tools).toEqual([]);
    expect(state.panes).toEqual([]);
    expect(state.activePaneIndex).toBe(0);
    expect(state.sessionCount).toBe(0);
    expect(state.configHealth).toBe("healthy");
  });

  it("returns a new object each time", () => {
    const a = createInitialState();
    const b = createInitialState();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// -- detectTools --

describe("detectTools()", () => {
  it("returns empty array when no adapters registered", async () => {
    const tools = await detectTools();
    expect(tools).toEqual([]);
  });

  it("returns detected tool with available status", async () => {
    registerMockAdapter("claude", {
      detected: true,
      sessions: [{ id: "s1" }, { id: "s2" }],
    });

    const tools = await detectTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      id: "claude",
      name: "claude Tool",
      command: "claude",
      status: "available",
      sessionCount: 2,
    });
  });

  it("returns not-installed tool when detect fails", async () => {
    registerMockAdapter("codex", { detected: false });

    const tools = await detectTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.status).toBe("not-installed");
    expect(tools[0]?.sessionCount).toBe(0);
  });

  it("handles detect() throwing error", async () => {
    (registry as unknown as { register: (a: MockAdapter) => void }).register({
      id: "broken",
      name: "Broken Tool",
      command: "broken",
      detect: async () => {
        throw new Error("detect failed");
      },
      parseSessions: async () => [],
    });

    const tools = await detectTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.status).toBe("not-installed");
  });

  it("handles parseSessions() throwing error", async () => {
    (registry as unknown as { register: (a: MockAdapter) => void }).register({
      id: "partial",
      name: "Partial Tool",
      command: "partial",
      detect: async () => true,
      parseSessions: async () => {
        throw new Error("parse failed");
      },
    });

    const tools = await detectTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.status).toBe("available");
    expect(tools[0]?.sessionCount).toBe(0);
  });

  it("returns multiple tools", async () => {
    registerMockAdapter("claude", { detected: true, sessions: [{ id: "s1" }] });
    registerMockAdapter("codex", { detected: false });
    registerMockAdapter("gemini", { detected: true, sessions: [] });

    const tools = await detectTools();
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.id)).toEqual(["claude", "codex", "gemini"]);
  });
});

// -- computeConfigHealth & detectMode --

describe("detectMode() and computeConfigHealth()", () => {
  it("returns error when neither .ai-tools nor direct markers exist", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ai-tools-ui-empty-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      expect(await detectMode()).toBe("unknown");
      expect(await computeConfigHealth()).toBe("error");
    } finally {
      cwdSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects expanded direct markers and reports healthy for direct-mode repos", async () => {
    const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    for (const marker of [".cursor", "AGENTS.md", ".mcp.json", "opencode.json", ".windsurf"]) {
      const dir = mkdtempSync(join(tmpdir(), "ai-tools-ui-direct-"));
      const target = join(dir, marker);
      if (marker.startsWith(".") && !marker.includes(".", 1)) {
        mkdirSync(target, { recursive: true });
      } else {
        writeFileSync(target, "", "utf-8");
      }
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
      try {
        expect(await detectMode()).toBe("direct");
        expect(await computeConfigHealth()).toBe("healthy");
      } finally {
        cwdSpy.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

// -- getStatusBarData --

describe("getStatusBarData()", () => {
  it("returns data with no active pane", () => {
    const state: AppState = {
      mode: "canonical",
      tools: [],
      panes: [],
      activePaneIndex: 0,
      sessionCount: 5,
      configHealth: "healthy",
    };

    const data = getStatusBarData(state);
    expect(data.mode).toBe("canonical");
    expect(data.activeTool).toBe("None");
    expect(data.sessionCount).toBe(5);
    expect(data.configHealth).toBe("healthy");
  });

  it("returns active tool name when pane exists", () => {
    const state: AppState = {
      mode: "direct",
      tools: [
        {
          id: "claude",
          name: "Claude Code",
          command: "claude",
          status: "running",
          sessionCount: 3,
        },
      ],
      panes: [{ toolId: "claude", active: true, pid: 123 }],
      activePaneIndex: 0,
      sessionCount: 3,
      configHealth: "stale",
    };

    const data = getStatusBarData(state);
    expect(data.mode).toBe("direct");
    expect(data.activeTool).toBe("Claude Code");
    expect(data.sessionCount).toBe(3);
    expect(data.configHealth).toBe("stale");
  });

  it("returns None when active pane tool not found in tools list", () => {
    const state: AppState = {
      mode: "unknown",
      tools: [],
      panes: [{ toolId: "ghost", active: true }],
      activePaneIndex: 0,
      sessionCount: 0,
      configHealth: "error",
    };

    const data = getStatusBarData(state);
    expect(data.activeTool).toBe("None");
  });

  it("handles activePaneIndex out of range", () => {
    const state: AppState = {
      mode: "canonical",
      tools: [],
      panes: [],
      activePaneIndex: 5,
      sessionCount: 0,
      configHealth: "healthy",
    };

    const data = getStatusBarData(state);
    expect(data.activeTool).toBe("None");
  });
});
