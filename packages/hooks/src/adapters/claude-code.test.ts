import { isAbsolute } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";

// Track removeFile calls from instances
const removeFileSpy = vi.fn();
const commandExistsSpy = vi.fn<(cmd: string) => Promise<boolean>>().mockResolvedValue(false);

// We need to mock the registry to prevent side effects during import
vi.mock("./index.js", () => {
  const registry = { register: vi.fn() };
  abstract class BaseAdapter {
    abstract readonly id: string;
    abstract readonly name: string;
    abstract readonly version: string;
    abstract readonly capabilities: unknown;
    abstract detect(): Promise<boolean>;
    abstract generate(hooks: HookDefinition[]): Promise<unknown[]>;
    abstract mapEvent(event: string): string[];
    abstract mapNativeEvent(nativeEvent: string): string[];
    async install() {}
    async uninstall() {}
    protected async commandExists(cmd: string) {
      return commandExistsSpy(cmd);
    }
    protected async removeFile(path: string) {
      removeFileSpy(path);
    }
  }
  return { BaseAdapter, registry };
});

// Mock fs modules to avoid real filesystem access in generateSettings
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ClaudeCodeAdapter } from "./claude-code.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

describe("ClaudeCodeAdapter", () => {
  let adapter: ClaudeCodeAdapter;

  const testHook: HookDefinition = {
    id: "test",
    name: "Test Hook",
    events: ["shell:before"],
    phase: "before",
    handler: makeHandler(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new ClaudeCodeAdapter();
  });

  // ── Metadata / Capabilities ────────────────────────────────

  describe("metadata", () => {
    it("has correct id", () => {
      expect(adapter.id).toBe("claude-code");
    });

    it("has correct name", () => {
      expect(adapter.name).toBe("Claude Code");
    });

    it("has correct version", () => {
      expect(adapter.version).toBe("1.0");
    });
  });

  describe("capabilities", () => {
    it("supports before hooks", () => {
      expect(adapter.capabilities.beforeHooks).toBe(true);
    });

    it("supports after hooks", () => {
      expect(adapter.capabilities.afterHooks).toBe(true);
    });

    it("supports MCP", () => {
      expect(adapter.capabilities.mcp).toBe(true);
    });

    it("supports config file generation", () => {
      expect(adapter.capabilities.configFile).toBe(true);
    });

    it("lists all supported events", () => {
      const expected: HookEventType[] = [
        "session:start",
        "session:end",
        "prompt:submit",
        "tool:before",
        "tool:after",
        "file:read",
        "file:write",
        "file:edit",
        "file:delete",
        "shell:before",
        "shell:after",
        "mcp:before",
        "mcp:after",
        "notification",
      ];
      expect(adapter.capabilities.supportedEvents).toEqual(expected);
    });

    it("lists all blockable events", () => {
      const expected: HookEventType[] = [
        "prompt:submit",
        "tool:before",
        "file:write",
        "file:edit",
        "file:delete",
        "shell:before",
        "mcp:before",
      ];
      expect(adapter.capabilities.blockableEvents).toEqual(expected);
    });

    it("blockable events are a subset of supported events", () => {
      for (const event of adapter.capabilities.blockableEvents) {
        expect(adapter.capabilities.supportedEvents).toContain(event);
      }
    });
  });

  // ── mapEvent ───────────────────────────────────────────────

  describe("mapEvent", () => {
    it("maps session:start to SessionStart", () => {
      expect(adapter.mapEvent("session:start")).toEqual(["SessionStart"]);
    });

    it("maps session:end to Stop", () => {
      expect(adapter.mapEvent("session:end")).toEqual(["Stop"]);
    });

    it("maps prompt:submit to UserPromptSubmit", () => {
      expect(adapter.mapEvent("prompt:submit")).toEqual(["UserPromptSubmit"]);
    });

    it("maps prompt:response to PostToolUse", () => {
      expect(adapter.mapEvent("prompt:response")).toEqual(["PostToolUse"]);
    });

    it("maps tool:before to PreToolUse", () => {
      expect(adapter.mapEvent("tool:before")).toEqual(["PreToolUse"]);
    });

    it("maps tool:after to PostToolUse", () => {
      expect(adapter.mapEvent("tool:after")).toEqual(["PostToolUse"]);
    });

    it("maps file:read to PreToolUse", () => {
      expect(adapter.mapEvent("file:read")).toEqual(["PreToolUse"]);
    });

    it("maps file:write to PreToolUse", () => {
      expect(adapter.mapEvent("file:write")).toEqual(["PreToolUse"]);
    });

    it("maps file:edit to PreToolUse", () => {
      expect(adapter.mapEvent("file:edit")).toEqual(["PreToolUse"]);
    });

    it("maps file:delete to PreToolUse", () => {
      expect(adapter.mapEvent("file:delete")).toEqual(["PreToolUse"]);
    });

    it("maps shell:before to PreToolUse", () => {
      expect(adapter.mapEvent("shell:before")).toEqual(["PreToolUse"]);
    });

    it("maps shell:after to PostToolUse", () => {
      expect(adapter.mapEvent("shell:after")).toEqual(["PostToolUse"]);
    });

    it("maps mcp:before to PreToolUse", () => {
      expect(adapter.mapEvent("mcp:before")).toEqual(["PreToolUse"]);
    });

    it("maps mcp:after to PostToolUse", () => {
      expect(adapter.mapEvent("mcp:after")).toEqual(["PostToolUse"]);
    });

    it("maps notification to Notification", () => {
      expect(adapter.mapEvent("notification")).toEqual(["Notification"]);
    });

    it("returns empty array for unknown event", () => {
      expect(adapter.mapEvent("unknown:event" as HookEventType)).toEqual([]);
    });
  });

  // ── mapNativeEvent ─────────────────────────────────────────

  describe("mapNativeEvent", () => {
    it("maps SessionStart to session:start", () => {
      expect(adapter.mapNativeEvent("SessionStart")).toEqual(["session:start"]);
    });

    it("maps UserPromptSubmit to prompt:submit", () => {
      expect(adapter.mapNativeEvent("UserPromptSubmit")).toEqual(["prompt:submit"]);
    });

    it("maps Stop to session:end", () => {
      expect(adapter.mapNativeEvent("Stop")).toEqual(["session:end"]);
    });

    it("maps PreToolUse to multiple universal events", () => {
      const result = adapter.mapNativeEvent("PreToolUse");
      expect(result).toEqual([
        "tool:before",
        "file:write",
        "file:edit",
        "file:delete",
        "shell:before",
        "mcp:before",
      ]);
    });

    it("maps PostToolUse to multiple universal events", () => {
      const result = adapter.mapNativeEvent("PostToolUse");
      expect(result).toEqual(["tool:after", "shell:after", "mcp:after"]);
    });

    it("maps Notification to notification", () => {
      expect(adapter.mapNativeEvent("Notification")).toEqual(["notification"]);
    });

    it("returns empty array for unknown native event", () => {
      expect(adapter.mapNativeEvent("UnknownNativeEvent")).toEqual([]);
    });

    it("returns empty array for empty string", () => {
      expect(adapter.mapNativeEvent("")).toEqual([]);
    });
  });

  // ── generate ───────────────────────────────────────────────

  describe("generate", () => {
    it("returns two config files (runner + settings)", async () => {
      const configs = await adapter.generate([testHook]);
      expect(configs).toHaveLength(2);
    });

    it("generates runner script at correct path", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner).toBeDefined();
      expect(runner!.path).toBe(".claude/hooks/ai-tools-hooks-runner.js");
    });

    it("runner script has correct format", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.format).toBe("js");
    });

    it("runner script is not gitignored", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.gitignore).toBe(false);
    });

    it("runner script contains shebang", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("#!/usr/bin/env node");
    });

    it("runner script imports from ai-hooks", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('import { loadConfig } from "@itz4blitz/ai-tools-hooks"');
      expect(runner!.content).toContain('import { HookEngine } from "@itz4blitz/ai-tools-hooks"');
    });

    it("runner script reads CLAUDE_HOOK_EVENT env var", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("process.env.CLAUDE_HOOK_EVENT");
    });

    it("runner script reads CLAUDE_TOOL_NAME env var", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("process.env.CLAUDE_TOOL_NAME");
    });

    it("runner script reads CLAUDE_TOOL_INPUT env var", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("process.env.CLAUDE_TOOL_INPUT");
    });

    it("runner script handles PreToolUse events with tool routing", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("resolvePreToolUse");
      expect(runner!.content).toContain("resolvePostToolUse");
    });

    it("runner script handles Write, Edit, Bash tool names", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('case "Write"');
      expect(runner!.content).toContain('case "Edit"');
      expect(runner!.content).toContain('case "Bash"');
    });

    it("runner script handles blocking with JSON output", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("decision");
      expect(runner!.content).toContain("block");
    });

    it("runner script contains DO NOT EDIT warning", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("DO NOT EDIT");
    });

    it("runner script embeds PROJECT_ROOT for worktree safety", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("const PROJECT_ROOT =");
      expect(runner!.content).toContain("process.chdir(PROJECT_ROOT)");
    });

    it("settings.json command uses absolute path to runner", async () => {
      const configs = await adapter.generate([testHook]);
      const settings = configs.find((c) => c.path.includes("settings"));
      const parsed = JSON.parse(settings!.content) as Record<string, unknown>;
      const hooks = parsed.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      const firstEvent = Object.keys(hooks)[0]!;
      const command = hooks[firstEvent]![0]!.hooks[0]!.command;
      expect(command.startsWith("node ")).toBe(true);
      expect(isAbsolute(command.slice("node ".length))).toBe(true);
    });

    it("generates settings.json at correct path", async () => {
      const configs = await adapter.generate([testHook]);
      const settings = configs.find((c) => c.path.includes("settings"));
      expect(settings).toBeDefined();
      expect(settings!.path).toBe(".claude/settings.json");
    });

    it("settings has correct format", async () => {
      const configs = await adapter.generate([testHook]);
      const settings = configs.find((c) => c.path.includes("settings"));
      expect(settings!.format).toBe("json");
    });

    it("settings is not gitignored", async () => {
      const configs = await adapter.generate([testHook]);
      const settings = configs.find((c) => c.path.includes("settings"));
      expect(settings!.gitignore).toBe(false);
    });

    it("settings contains valid JSON", async () => {
      const configs = await adapter.generate([testHook]);
      const settings = configs.find((c) => c.path.includes("settings"));
      const parsed = JSON.parse(settings!.content) as Record<string, unknown>;
      expect(parsed).toBeDefined();
      expect(parsed.hooks).toBeDefined();
    });

    it("settings contains PreToolUse hook for shell:before event", async () => {
      const configs = await adapter.generate([testHook]);
      const settings = configs.find((c) => c.path.includes("settings"));
      const parsed = JSON.parse(settings!.content) as {
        hooks: Record<
          string,
          Array<{
            hooks: Array<{ description: string; command: string; timeout: number; type: string }>;
          }>
        >;
      };
      const preToolUseEntries = parsed.hooks.PreToolUse;
      expect(preToolUseEntries).toBeDefined();
      expect(preToolUseEntries).toHaveLength(1);
      const entry = preToolUseEntries![0]!;
      expect(entry.hooks).toHaveLength(1);
      expect(entry.hooks[0]!.type).toBe("command");
      expect(entry.hooks[0]!.command).toContain("ai-tools-hooks-runner.js");
      expect(entry.hooks[0]!.timeout).toBe(10);
      expect(entry.hooks[0]!.description).toBe("ai-hooks: PreToolUse");
    });

    it("maps multiple hook events to correct native events", async () => {
      const multiHook: HookDefinition = {
        id: "multi",
        name: "Multi Hook",
        events: ["session:start", "tool:after", "notification"],
        phase: "after",
        handler: makeHandler(),
      };
      const configs = await adapter.generate([multiHook]);
      const settings = configs.find((c) => c.path.includes("settings"));
      const parsed = JSON.parse(settings!.content) as {
        hooks: Record<string, unknown[]>;
      };
      expect(parsed.hooks.SessionStart).toBeDefined();
      expect(parsed.hooks.PostToolUse).toBeDefined();
      expect(parsed.hooks.Notification).toBeDefined();
    });

    it("deduplicates native events from multiple hooks mapping to same native event", async () => {
      const hooks: HookDefinition[] = [
        {
          id: "hook1",
          name: "Hook 1",
          events: ["tool:before"],
          phase: "before",
          handler: makeHandler(),
        },
        {
          id: "hook2",
          name: "Hook 2",
          events: ["file:write"],
          phase: "before",
          handler: makeHandler(),
        },
      ];
      const configs = await adapter.generate(hooks);
      const settings = configs.find((c) => c.path.includes("settings"));
      const parsed = JSON.parse(settings!.content) as {
        hooks: Record<string, unknown[]>;
      };
      // Both map to PreToolUse, should only have one entry
      expect(parsed.hooks.PreToolUse).toHaveLength(1);
    });

    it("maps a session:end hook to Stop", async () => {
      const stopHook: HookDefinition = {
        id: "stop",
        name: "Stop Hook",
        events: ["session:end"],
        phase: "after",
        handler: makeHandler(),
      };
      const configs = await adapter.generate([stopHook]);
      const settings = configs.find((c) => c.path.includes("settings"));
      const parsed = JSON.parse(settings!.content) as {
        hooks: Record<string, unknown[]>;
      };
      expect(parsed.hooks.Stop).toHaveLength(1);
    });

    it("generates config for empty hooks array", async () => {
      const configs = await adapter.generate([]);
      expect(configs).toHaveLength(2);
      const settings = configs.find((c) => c.path.includes("settings"));
      const parsed = JSON.parse(settings!.content) as {
        hooks: Record<string, unknown[]>;
      };
      expect(Object.keys(parsed.hooks)).toHaveLength(0);
    });

    it("merges with existing settings.json when file exists", async () => {
      const existingSettings = {
        customKey: "preserved",
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo hi", description: "custom hook" }] },
          ],
        },
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(existingSettings));

      const configs = await adapter.generate([testHook]);
      const settings = configs.find((c) => c.path.includes("settings"));
      const parsed = JSON.parse(settings!.content) as {
        customKey: string;
        hooks: Record<string, unknown[]>;
      };
      // Preserves non-hooks keys
      expect(parsed.customKey).toBe("preserved");
      // Preserves existing non-ai-hooks hook entries
      expect(parsed.hooks.SessionStart).toBeDefined();
      expect(parsed.hooks.SessionStart).toHaveLength(1);
      // Also has the new PreToolUse entry
      expect(parsed.hooks.PreToolUse).toBeDefined();
    });

    it("removes old ai-hooks entries from existing settings and replaces them", async () => {
      const existingSettings = {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: "command", command: "old-runner.js", description: "ai-hooks: PreToolUse" },
              ],
            },
            {
              hooks: [{ type: "command", command: "echo custom", description: "my custom hook" }],
            },
          ],
        },
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(existingSettings));

      const configs = await adapter.generate([testHook]);
      const settings = configs.find((c) => c.path.includes("settings"));
      const parsed = JSON.parse(settings!.content) as {
        hooks: Record<string, Array<{ hooks: Array<{ description: string; command: string }> }>>;
      };
      const preToolUse = parsed.hooks.PreToolUse;
      // Old ai-hooks entry removed, custom entry preserved, new ai-hooks entry added
      expect(preToolUse).toBeDefined();
      expect(preToolUse).toHaveLength(2);
      const descriptions = preToolUse!.flatMap((e) => e.hooks.map((h) => h.description));
      expect(descriptions).toContain("my custom hook");
      expect(descriptions).toContain("ai-hooks: PreToolUse");
    });
  });

  // ── detect ──────────────────────────────────────────────────

  describe("detect", () => {
    it("returns false when neither command nor directory exists", async () => {
      commandExistsSpy.mockResolvedValue(false);
      vi.mocked(existsSync).mockReturnValue(false);
      const result = await adapter.detect();
      expect(result).toBe(false);
    });

    it("returns true when claude command exists", async () => {
      commandExistsSpy.mockResolvedValue(true);
      vi.mocked(existsSync).mockReturnValue(false);
      const result = await adapter.detect();
      expect(result).toBe(true);
    });

    it("returns true when .claude directory exists", async () => {
      commandExistsSpy.mockResolvedValue(false);
      vi.mocked(existsSync).mockReturnValue(true);
      const result = await adapter.detect();
      expect(result).toBe(true);
    });

    it("returns true when both command and directory exist", async () => {
      commandExistsSpy.mockResolvedValue(true);
      vi.mocked(existsSync).mockReturnValue(true);
      const result = await adapter.detect();
      expect(result).toBe(true);
    });
  });

  // ── uninstall ───────────────────────────────────────────────

  describe("uninstall", () => {
    it("removes the runner script", async () => {
      await adapter.uninstall();
      expect(removeFileSpy).toHaveBeenCalledWith(".claude/hooks/ai-tools-hooks-runner.js");
    });

    it("calls removeFile for both legacy and current runner names", async () => {
      await adapter.uninstall();
      expect(removeFileSpy).toHaveBeenCalledTimes(2);
    });
  });
});
