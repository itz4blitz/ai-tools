import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionContext, UnifiedSession } from "@itz4blitz/ai-tools-sessions";

const mockAdapters: Array<{
  id: string;
  detect: () => Promise<boolean>;
  parseSessions: () => Promise<UnifiedSession[]>;
  extractContext: (session: UnifiedSession) => Promise<SessionContext>;
}> = [];

vi.mock("@itz4blitz/ai-tools-sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@itz4blitz/ai-tools-sessions")>();
  return {
    ...actual,
    registry: {
      detectAll: async () => mockAdapters,
    },
  };
});

vi.mock("@itz4blitz/ai-tools-sessions/adapters/all", () => ({}));

import { performHandoff } from "./handoff.js";

function makeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: "s1",
    tool: "claude",
    title: "Test Session",
    summary: "A test summary",
    keyFiles: ["./src/index.ts"],
    keyDecisions: ["Use TypeScript"],
    lastActivity: "2025-01-01T01:00:00Z",
    handoffMarkdown: "# Handoff content",
    ...overrides,
  };
}

function makeSession(id: string = "s1"): UnifiedSession {
  return {
    id,
    tool: "claude",
    toolName: "Claude Code",
    startedAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T01:00:00Z",
    messageCount: 2,
    messages: [],
  };
}

beforeEach(() => {
  mockAdapters.length = 0;
  vi.clearAllMocks();
});

describe("performHandoff()", () => {
  it("returns null when session not found", async () => {
    const result = await performHandoff("nonexistent");
    expect(result).toBeNull();
  });

  it("returns handoff result with context and preview", async () => {
    const context = makeContext();
    mockAdapters.push({
      id: "claude",
      detect: async () => true,
      parseSessions: async () => [makeSession()],
      extractContext: async () => context,
    });

    const result = await performHandoff("s1");
    expect(result).not.toBeNull();
    expect(result?.context).toEqual(context);
    expect(result?.preview).toContain("Handoff Preview");
    expect(result?.launchCommand).toBeNull();
    expect(result?.launchArgs).toEqual([]);
  });

  it("passes positional prompt for claude, claude-code, and codex", async () => {
    const context = makeContext();
    mockAdapters.push({
      id: "claude",
      detect: async () => true,
      parseSessions: async () => [makeSession()],
      extractContext: async () => context,
    });

    const claudeResult = await performHandoff("s1", "claude");
    expect(claudeResult?.launchCommand).toBe("claude");
    expect(claudeResult?.launchArgs).toEqual(["# Handoff content"]);

    const claudeAliasResult = await performHandoff("s1", "claude-code");
    expect(claudeAliasResult?.launchCommand).toBe("claude");
    expect(claudeAliasResult?.launchArgs).toEqual(["# Handoff content"]);

    const codexResult = await performHandoff("s1", "codex");
    expect(codexResult?.launchCommand).toBe("codex");
    expect(codexResult?.launchArgs).toEqual(["# Handoff content"]);
  });

  it("passes -i prompt flag for gemini and gemini-cli", async () => {
    const context = makeContext();
    mockAdapters.push({
      id: "claude",
      detect: async () => true,
      parseSessions: async () => [makeSession()],
      extractContext: async () => context,
    });

    const geminiResult = await performHandoff("s1", "gemini");
    expect(geminiResult?.launchCommand).toBe("gemini");
    expect(geminiResult?.launchArgs).toEqual(["-i", "# Handoff content"]);

    const geminiAliasResult = await performHandoff("s1", "gemini-cli");
    expect(geminiAliasResult?.launchCommand).toBe("gemini");
    expect(geminiAliasResult?.launchArgs).toEqual(["-i", "# Handoff content"]);
  });

  it("passes --prompt flag for opencode", async () => {
    const context = makeContext();
    mockAdapters.push({
      id: "claude",
      detect: async () => true,
      parseSessions: async () => [makeSession()],
      extractContext: async () => context,
    });

    const opencodeResult = await performHandoff("s1", "opencode");
    expect(opencodeResult?.launchCommand).toBe("opencode");
    expect(opencodeResult?.launchArgs).toEqual(["--prompt", "# Handoff content"]);
  });

  it("returns null launch command for unknown target tool", async () => {
    const context = makeContext();
    mockAdapters.push({
      id: "claude",
      detect: async () => true,
      parseSessions: async () => [makeSession()],
      extractContext: async () => context,
    });

    const result = await performHandoff("s1", "unknown-tool");
    expect(result?.launchCommand).toBeNull();
    expect(result?.launchArgs).toEqual([]);
  });
});
