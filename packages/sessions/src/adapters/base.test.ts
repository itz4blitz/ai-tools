import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BaseSessionAdapter } from "./base.js";
import type { UnifiedSession, SessionFilter } from "../types/index.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/testuser"),
}));

import { existsSync } from "node:fs";

class TestSessionAdapter extends BaseSessionAdapter {
  readonly id = "test";
  readonly name = "Test Tool";
  readonly command = "test-tool";
  readonly storagePaths = ["~/.test-tool/sessions"];

  async parseSessions(filter?: SessionFilter): Promise<UnifiedSession[]> {
    void filter;
    return [];
  }
}

function makeSession(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: "sess-1",
    tool: "test",
    toolName: "Test Tool",
    startedAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T01:00:00Z",
    messageCount: 3,
    messages: [
      { role: "user", content: "Fix the bug in ./src/parser.ts" },
      {
        role: "assistant",
        content:
          "I'll refactor the parser to handle edge cases properly. Let me also update ./src/utils.ts for consistency.",
      },
      { role: "user", content: "Looks good, thanks!" },
    ],
    ...overrides,
  };
}

describe("BaseSessionAdapter", () => {
  let adapter: TestSessionAdapter;

  beforeEach(() => {
    adapter = new TestSessionAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("properties", () => {
    it("exposes id, name, command, and storagePaths", () => {
      expect(adapter.id).toBe("test");
      expect(adapter.name).toBe("Test Tool");
      expect(adapter.command).toBe("test-tool");
      expect(adapter.storagePaths).toEqual(["~/.test-tool/sessions"]);
    });
  });

  describe("getStoragePath()", () => {
    it("returns resolved path when storage exists", async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const path = await adapter.getStoragePath();
      expect(path).toBe("/home/testuser/.test-tool/sessions");
    });

    it("returns null when storage does not exist", async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const path = await adapter.getStoragePath();
      expect(path).toBeNull();
    });

    it("expands %APPDATA% and %LOCALAPPDATA% environment placeholders", async () => {
      const prevAppData = process.env.APPDATA;
      const prevLocalAppData = process.env.LOCALAPPDATA;
      process.env.APPDATA = "C:\\Users\\dev\\AppData\\Roaming";
      process.env.LOCALAPPDATA = "C:\\Users\\dev\\AppData\\Local";

      class WinStorageAdapter extends BaseSessionAdapter {
        readonly id = "win";
        readonly name = "Win Tool";
        readonly command = "win-tool";
        readonly storagePaths = ["%APPDATA%\\WinTool\\sessions", "%LOCALAPPDATA%\\WinTool"];
        async parseSessions(): Promise<UnifiedSession[]> {
          return [];
        }
      }

      try {
        vi.mocked(existsSync).mockImplementation(
          (p) => String(p) === "C:\\Users\\dev\\AppData\\Local\\WinTool",
        );
        const winAdapter = new WinStorageAdapter();
        expect(await winAdapter.getStoragePath()).toBe("C:\\Users\\dev\\AppData\\Local\\WinTool");
      } finally {
        if (prevAppData === undefined) delete process.env.APPDATA;
        else process.env.APPDATA = prevAppData;
        if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = prevLocalAppData;
      }
    });
  });

  describe("detect() / commandExists()", () => {
    it("detects node binary on the current platform via where/which", async () => {
      class NodeToolAdapter extends BaseSessionAdapter {
        readonly id = "node-tool";
        readonly name = "Node Tool";
        readonly command = "node";
        readonly storagePaths: string[] = [];
        async parseSessions(): Promise<UnifiedSession[]> {
          return [];
        }
      }
      expect(await new NodeToolAdapter().detect()).toBe(true);
    });

    it("returns false for a nonexistent binary", async () => {
      class MissingToolAdapter extends BaseSessionAdapter {
        readonly id = "missing";
        readonly name = "Missing";
        readonly command = "definitely-not-a-real-binary-xyz-987654";
        readonly storagePaths: string[] = [];
        async parseSessions(): Promise<UnifiedSession[]> {
          return [];
        }
      }
      expect(await new MissingToolAdapter().detect()).toBe(false);
    });
  });

  describe("extractContext()", () => {
    it("extracts context from a session", async () => {
      const session = makeSession();
      const ctx = await adapter.extractContext(session);

      expect(ctx.sessionId).toBe("sess-1");
      expect(ctx.tool).toBe("test");
      expect(ctx.title).toBe("Fix the bug in ./src/parser.ts");
      expect(ctx.summary).toContain("3 messages");
      expect(ctx.keyFiles).toContain("./src/parser.ts");
      expect(ctx.keyFiles).toContain("./src/utils.ts");
      expect(ctx.keyDecisions.length).toBeGreaterThan(0);
      expect(ctx.handoffMarkdown).toContain("# Session Handoff");
    });

    it("uses session title when available", async () => {
      const session = makeSession({ title: "Bug Fix Session" });
      const ctx = await adapter.extractContext(session);
      expect(ctx.title).toBe("Bug Fix Session");
    });

    it("normalizes explicit session title", async () => {
      const session = makeSession({ title: "   `  Tidy    parser errors   `  " });
      const ctx = await adapter.extractContext(session);
      expect(ctx.title).toBe("Tidy parser errors");
    });

    it("generates fallback title from first user message", async () => {
      const session = makeSession({ title: undefined });
      const ctx = await adapter.extractContext(session);
      expect(ctx.title).toBe("Fix the bug in ./src/parser.ts");
    });

    it("falls back to tool name when no usable message text", async () => {
      const session = makeSession({
        title: undefined,
        messages: [{ role: "tool", content: "```" }],
      });
      const ctx = await adapter.extractContext(session);
      expect(ctx.title).toBe("Test Tool session");
    });

    it("uses first meaningful line from markdown content", async () => {
      const session = makeSession({
        title: undefined,
        messages: [{ role: "user", content: "\n## Build status\n- Fix failing tests" }],
      });
      const ctx = await adapter.extractContext(session);
      expect(ctx.title).toBe("Build status");
    });

    it("truncates very long derived titles", async () => {
      const session = makeSession({
        title: undefined,
        messages: [{ role: "user", content: "x".repeat(120) }],
      });
      const ctx = await adapter.extractContext(session);
      expect(ctx.title.length).toBeLessThanOrEqual(80);
      expect(ctx.title.endsWith("...")).toBe(true);
    });
  });

  describe("extractFileReferences()", () => {
    it("extracts file paths from messages", async () => {
      const session = makeSession();
      const ctx = await adapter.extractContext(session);
      expect(ctx.keyFiles).toContain("./src/parser.ts");
      expect(ctx.keyFiles).toContain("./src/utils.ts");
    });

    it("deduplicates file references", async () => {
      const session = makeSession({
        messages: [
          { role: "user", content: "Check ./src/parser.ts" },
          { role: "assistant", content: "Looking at ./src/parser.ts now." },
        ],
      });
      const ctx = await adapter.extractContext(session);
      const parserCount = ctx.keyFiles.filter((f) => f === "./src/parser.ts").length;
      expect(parserCount).toBe(1);
    });

    it("handles sessions with no file references", async () => {
      const session = makeSession({
        messages: [{ role: "user", content: "Hello!" }],
      });
      const ctx = await adapter.extractContext(session);
      expect(ctx.keyFiles).toEqual([]);
    });
  });

  describe("extractDecisions()", () => {
    it("extracts decisions from assistant messages", async () => {
      const session = makeSession({
        messages: [
          {
            role: "assistant",
            content: "I'll refactor the parser to handle edge cases properly.",
          },
        ],
      });
      const ctx = await adapter.extractContext(session);
      expect(ctx.keyDecisions.length).toBeGreaterThan(0);
      expect(ctx.keyDecisions[0]).toContain("refactor the parser");
    });

    it("ignores user messages for decisions", async () => {
      const session = makeSession({
        messages: [{ role: "user", content: "I'll fix the bug myself." }],
      });
      const ctx = await adapter.extractContext(session);
      expect(ctx.keyDecisions).toEqual([]);
    });

    it("limits decisions to 10", async () => {
      const messages = Array.from({ length: 20 }, (_, i) => ({
        role: "assistant" as const,
        content: `I'll implement feature number ${i + 1} in this iteration of the project.`,
      }));
      const session = makeSession({ messages });
      const ctx = await adapter.extractContext(session);
      expect(ctx.keyDecisions.length).toBeLessThanOrEqual(10);
    });
  });

  describe("generateSummary()", () => {
    it("includes message count and first user message", async () => {
      const session = makeSession();
      const ctx = await adapter.extractContext(session);
      expect(ctx.summary).toContain("3 messages");
      expect(ctx.summary).toContain("Fix the bug");
    });

    it("truncates long first messages", async () => {
      const longMessage = "x".repeat(300);
      const session = makeSession({
        messages: [{ role: "user", content: longMessage }],
      });
      const ctx = await adapter.extractContext(session);
      expect(ctx.summary).toContain("...");
    });

    it("handles sessions with no user messages", async () => {
      const session = makeSession({
        messages: [{ role: "assistant", content: "Hello!" }],
      });
      const ctx = await adapter.extractContext(session);
      expect(ctx.summary).toContain("No user messages");
    });
  });

  describe("formatHandoff()", () => {
    it("generates markdown with all sections", async () => {
      const session = makeSession();
      const ctx = await adapter.extractContext(session);
      expect(ctx.handoffMarkdown).toContain("# Session Handoff");
      expect(ctx.handoffMarkdown).toContain("**From:** test");
      expect(ctx.handoffMarkdown).toContain("## Summary");
      expect(ctx.handoffMarkdown).toContain("## Key Files");
    });

    it("omits key files section when empty", async () => {
      const session = makeSession({
        messages: [{ role: "user", content: "Hello" }],
      });
      const ctx = await adapter.extractContext(session);
      expect(ctx.handoffMarkdown).not.toContain("## Key Files");
    });

    it("omits key decisions section when empty", async () => {
      const session = makeSession({
        messages: [{ role: "user", content: "Hello" }],
      });
      const ctx = await adapter.extractContext(session);
      expect(ctx.handoffMarkdown).not.toContain("## Key Decisions");
    });
  });
});
