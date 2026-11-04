import { isAbsolute, sep } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";

// Mock the registry to prevent side effects during import
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
    protected async commandExists() {
      return false;
    }
    protected async removeFile() {}
  }
  return { BaseAdapter, registry };
});

// Mock fs to avoid real filesystem access
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

import { CursorAdapter } from "./cursor.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

describe("CursorAdapter", () => {
  let adapter: CursorAdapter;

  const testHook: HookDefinition = {
    id: "test",
    name: "Test Hook",
    events: ["shell:before"],
    phase: "before",
    handler: makeHandler(),
  };

  beforeEach(() => {
    adapter = new CursorAdapter();
  });

  // ── Metadata / Capabilities ────────────────────────────────

  describe("metadata", () => {
    it("has correct id", () => {
      expect(adapter.id).toBe("cursor");
    });

    it("has correct name", () => {
      expect(adapter.name).toBe("Cursor");
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
        "session:end",
        "prompt:submit",
        "prompt:response",
        "tool:before",
        "file:read",
        "file:write",
        "file:edit",
        "shell:before",
        "mcp:before",
      ];
      expect(adapter.capabilities.supportedEvents).toEqual(expected);
    });

    it("lists all blockable events", () => {
      const expected: HookEventType[] = ["shell:before", "mcp:before", "tool:before"];
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
    it("maps session:start to empty array (unsupported)", () => {
      expect(adapter.mapEvent("session:start")).toEqual([]);
    });

    it("maps session:end to stop", () => {
      expect(adapter.mapEvent("session:end")).toEqual(["stop"]);
    });

    it("maps prompt:submit to beforeSubmitPrompt", () => {
      expect(adapter.mapEvent("prompt:submit")).toEqual(["beforeSubmitPrompt"]);
    });

    it("maps prompt:response to stop", () => {
      expect(adapter.mapEvent("prompt:response")).toEqual(["stop"]);
    });

    it("maps tool:before to beforeMCPExecution", () => {
      expect(adapter.mapEvent("tool:before")).toEqual(["beforeMCPExecution"]);
    });

    it("maps tool:after to empty array (unsupported)", () => {
      expect(adapter.mapEvent("tool:after")).toEqual([]);
    });

    it("maps file:read to beforeReadFile", () => {
      expect(adapter.mapEvent("file:read")).toEqual(["beforeReadFile"]);
    });

    it("maps file:write to afterFileEdit", () => {
      expect(adapter.mapEvent("file:write")).toEqual(["afterFileEdit"]);
    });

    it("maps file:edit to afterFileEdit", () => {
      expect(adapter.mapEvent("file:edit")).toEqual(["afterFileEdit"]);
    });

    it("maps file:delete to empty array (unsupported)", () => {
      expect(adapter.mapEvent("file:delete")).toEqual([]);
    });

    it("maps shell:before to beforeShellExecution", () => {
      expect(adapter.mapEvent("shell:before")).toEqual(["beforeShellExecution"]);
    });

    it("maps shell:after to empty array (unsupported)", () => {
      expect(adapter.mapEvent("shell:after")).toEqual([]);
    });

    it("maps mcp:before to beforeMCPExecution", () => {
      expect(adapter.mapEvent("mcp:before")).toEqual(["beforeMCPExecution"]);
    });

    it("maps mcp:after to empty array (unsupported)", () => {
      expect(adapter.mapEvent("mcp:after")).toEqual([]);
    });

    it("returns empty array for unknown event", () => {
      expect(adapter.mapEvent("unknown:event" as HookEventType)).toEqual([]);
    });

    it("returns empty array for notification (not in Cursor event map)", () => {
      expect(adapter.mapEvent("notification" as HookEventType)).toEqual([]);
    });
  });

  // ── mapNativeEvent ─────────────────────────────────────────

  describe("mapNativeEvent", () => {
    it("maps beforeSubmitPrompt to prompt:submit", () => {
      expect(adapter.mapNativeEvent("beforeSubmitPrompt")).toEqual(["prompt:submit"]);
    });

    it("maps beforeShellExecution to shell:before", () => {
      expect(adapter.mapNativeEvent("beforeShellExecution")).toEqual(["shell:before"]);
    });

    it("maps beforeMCPExecution to tool:before and mcp:before", () => {
      expect(adapter.mapNativeEvent("beforeMCPExecution")).toEqual(["tool:before", "mcp:before"]);
    });

    it("maps beforeReadFile to file:read", () => {
      expect(adapter.mapNativeEvent("beforeReadFile")).toEqual(["file:read"]);
    });

    it("maps afterFileEdit to file:write and file:edit", () => {
      expect(adapter.mapNativeEvent("afterFileEdit")).toEqual(["file:write", "file:edit"]);
    });

    it("maps stop to session:end and prompt:response", () => {
      expect(adapter.mapNativeEvent("stop")).toEqual(["session:end", "prompt:response"]);
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
    it("returns two config files (runner + hooks.json)", async () => {
      const configs = await adapter.generate([testHook]);
      expect(configs).toHaveLength(2);
    });

    it("generates runner script at correct path", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner).toBeDefined();
      expect(runner!.path).toBe(".cursor/hooks/ai-tools-hooks-runner.js");
    });

    it("runner script has correct format", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.format).toBe("js");
    });

    it("runner script contains shebang", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("#!/usr/bin/env node");
    });

    it("runner script imports from ai-hooks", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain(
        'import { loadConfig, HookEngine } from "@itz4blitz/ai-tools-hooks"',
      );
    });

    it("runner script reads event name from process.argv", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("process.argv[2]");
    });

    it("runner script reads STDIN for input data", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("readStdin");
      expect(runner!.content).toContain("process.stdin");
    });

    it("runner script handles beforeSubmitPrompt event", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"beforeSubmitPrompt"');
    });

    it("runner script handles beforeShellExecution event", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"beforeShellExecution"');
    });

    it("runner script handles beforeMCPExecution event", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"beforeMCPExecution"');
    });

    it("runner script handles beforeReadFile event", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"beforeReadFile"');
    });

    it("runner script handles afterFileEdit event", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"afterFileEdit"');
    });

    it("runner script handles stop event", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"stop"');
    });

    it("runner script handles blocking with permission deny JSON", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("permission");
      expect(runner!.content).toContain("deny");
    });

    it("runner script outputs permission allow for blocking events when not blocked", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"allow"');
    });

    it("runner script includes agentMessage in deny response", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("agentMessage");
    });

    it("runner script includes userMessage in deny response", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("userMessage");
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

    it("hooks.json command uses absolute path to runner", async () => {
      const configs = await adapter.generate([testHook]);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, Array<{ command: string }>>;
      };
      const firstEvent = Object.keys(parsed.hooks)[0]!;
      const command = parsed.hooks[firstEvent]![0]!.command;
      expect(command.startsWith("node ")).toBe(true);
      expect(isAbsolute(command.slice("node ".length))).toBe(true);
    });

    it("generates hooks.json at correct path", async () => {
      const configs = await adapter.generate([testHook]);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      expect(hooksJson).toBeDefined();
    });

    it("hooks.json has correct format", async () => {
      const configs = await adapter.generate([testHook]);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      expect(hooksJson!.format).toBe("json");
    });

    it("hooks.json contains valid JSON with version 1", async () => {
      const configs = await adapter.generate([testHook]);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      const parsed = JSON.parse(hooksJson!.content) as {
        version: number;
        hooks: Record<string, unknown>;
      };
      expect(parsed.version).toBe(1);
      expect(parsed.hooks).toBeDefined();
    });

    it("hooks.json maps shell:before to beforeShellExecution entry", async () => {
      const configs = await adapter.generate([testHook]);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, Array<{ command: string }>>;
      };
      const entry = parsed.hooks.beforeShellExecution;
      expect(entry).toBeDefined();
      expect(entry).toHaveLength(1);
      expect(entry![0]!.command).toContain("ai-tools-hooks-runner.js");
      expect(entry![0]!.command).toContain("beforeShellExecution");
    });

    it("hook command passes native event name as argument", async () => {
      const configs = await adapter.generate([testHook]);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, Array<{ command: string }>>;
      };
      const entry = parsed.hooks.beforeShellExecution;
      expect(entry![0]!.command).toContain("ai-tools-hooks-runner.js beforeShellExecution");
      const suffix = `${sep}.cursor${sep}hooks${sep}ai-tools-hooks-runner.js beforeShellExecution`;
      expect(entry![0]!.command.startsWith("node ")).toBe(true);
      expect(entry![0]!.command.endsWith(suffix)).toBe(true);
      expect(
        isAbsolute(entry![0]!.command.slice("node ".length, -" beforeShellExecution".length)),
      ).toBe(true);
    });

    it("maps multiple hook events to correct native events", async () => {
      const multiHook: HookDefinition = {
        id: "multi",
        name: "Multi Hook",
        events: ["prompt:submit", "shell:before", "file:read"],
        phase: "before",
        handler: makeHandler(),
      };
      const configs = await adapter.generate([multiHook]);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, unknown[]>;
      };
      expect(parsed.hooks.beforeSubmitPrompt).toBeDefined();
      expect(parsed.hooks.beforeShellExecution).toBeDefined();
      expect(parsed.hooks.beforeReadFile).toBeDefined();
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
          events: ["mcp:before"],
          phase: "before",
          handler: makeHandler(),
        },
      ];
      const configs = await adapter.generate(hooks);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, unknown[]>;
      };
      // Both map to beforeMCPExecution, should only have one entry
      expect(parsed.hooks.beforeMCPExecution).toHaveLength(1);
    });

    it("deduplicates file:write and file:edit both mapping to afterFileEdit", async () => {
      const hooks: HookDefinition[] = [
        {
          id: "hook1",
          name: "Hook 1",
          events: ["file:write"],
          phase: "before",
          handler: makeHandler(),
        },
        {
          id: "hook2",
          name: "Hook 2",
          events: ["file:edit"],
          phase: "before",
          handler: makeHandler(),
        },
      ];
      const configs = await adapter.generate(hooks);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, unknown[]>;
      };
      expect(parsed.hooks.afterFileEdit).toHaveLength(1);
    });

    it("returns empty hooks config for hooks with no native event mappings", async () => {
      const unmappedHook: HookDefinition = {
        id: "unmapped",
        name: "Unmapped Hook",
        events: ["session:start"],
        phase: "before",
        handler: makeHandler(),
      };
      const configs = await adapter.generate([unmappedHook]);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, unknown[]>;
      };
      expect(Object.keys(parsed.hooks)).toHaveLength(0);
    });

    it("generates config for empty hooks array", async () => {
      const configs = await adapter.generate([]);
      expect(configs).toHaveLength(2);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, unknown[]>;
      };
      expect(Object.keys(parsed.hooks)).toHaveLength(0);
    });

    it("session:end and prompt:response both map to stop", async () => {
      const hooks: HookDefinition[] = [
        {
          id: "hook1",
          name: "Hook 1",
          events: ["session:end"],
          phase: "after",
          handler: makeHandler(),
        },
        {
          id: "hook2",
          name: "Hook 2",
          events: ["prompt:response"],
          phase: "after",
          handler: makeHandler(),
        },
      ];
      const configs = await adapter.generate(hooks);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, unknown[]>;
      };
      // Both map to stop, should only have one entry (deduplication via Set)
      expect(parsed.hooks.stop).toHaveLength(1);
    });

    it("unsupported events like tool:after produce no native entries", async () => {
      const hook: HookDefinition = {
        id: "unsupported",
        name: "Unsupported Hook",
        events: ["tool:after"],
        phase: "after",
        handler: makeHandler(),
      };
      const configs = await adapter.generate([hook]);
      const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, unknown[]>;
      };
      expect(Object.keys(parsed.hooks)).toHaveLength(0);
    });
  });

  // ── detect ─────────────────────────────────────────────────

  describe("detect", () => {
    it("returns false when neither command nor directory exists", async () => {
      const result = await adapter.detect();
      expect(result).toBe(false);
    });
  });

  // ── uninstall ──────────────────────────────────────────────

  describe("uninstall", () => {
    it("completes without error", async () => {
      await expect(adapter.uninstall()).resolves.toBeUndefined();
    });
  });
});
