import { isAbsolute } from "node:path";
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

import { KiroAdapter } from "./kiro.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

describe("KiroAdapter", () => {
  let adapter: KiroAdapter;

  const testHook: HookDefinition = {
    id: "test",
    name: "Test Hook",
    events: ["shell:before"],
    phase: "before",
    handler: makeHandler(),
  };

  beforeEach(() => {
    adapter = new KiroAdapter();
  });

  // ── Metadata / Capabilities ────────────────────────────────

  describe("metadata", () => {
    it("has correct id", () => {
      expect(adapter.id).toBe("kiro");
    });

    it("has correct name", () => {
      expect(adapter.name).toBe("Kiro CLI");
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
        "prompt:response",
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
      ];
      expect(adapter.capabilities.supportedEvents).toEqual(expected);
    });

    it("lists all blockable events", () => {
      const expected: HookEventType[] = [
        "tool:before",
        "file:read",
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
    it("maps session:start to agentSpawn", () => {
      expect(adapter.mapEvent("session:start")).toEqual(["agentSpawn"]);
    });

    it("maps session:end to stop", () => {
      expect(adapter.mapEvent("session:end")).toEqual(["stop"]);
    });

    it("maps prompt:submit to userPromptSubmit", () => {
      expect(adapter.mapEvent("prompt:submit")).toEqual(["userPromptSubmit"]);
    });

    it("maps prompt:response to stop", () => {
      expect(adapter.mapEvent("prompt:response")).toEqual(["stop"]);
    });

    it("maps tool:before to preToolUse", () => {
      expect(adapter.mapEvent("tool:before")).toEqual(["preToolUse"]);
    });

    it("maps tool:after to postToolUse", () => {
      expect(adapter.mapEvent("tool:after")).toEqual(["postToolUse"]);
    });

    it("maps file:read to preToolUse", () => {
      expect(adapter.mapEvent("file:read")).toEqual(["preToolUse"]);
    });

    it("maps file:write to preToolUse", () => {
      expect(adapter.mapEvent("file:write")).toEqual(["preToolUse"]);
    });

    it("maps file:edit to preToolUse", () => {
      expect(adapter.mapEvent("file:edit")).toEqual(["preToolUse"]);
    });

    it("maps file:delete to preToolUse", () => {
      expect(adapter.mapEvent("file:delete")).toEqual(["preToolUse"]);
    });

    it("maps shell:before to preToolUse", () => {
      expect(adapter.mapEvent("shell:before")).toEqual(["preToolUse"]);
    });

    it("maps shell:after to postToolUse", () => {
      expect(adapter.mapEvent("shell:after")).toEqual(["postToolUse"]);
    });

    it("maps mcp:before to preToolUse", () => {
      expect(adapter.mapEvent("mcp:before")).toEqual(["preToolUse"]);
    });

    it("maps mcp:after to postToolUse", () => {
      expect(adapter.mapEvent("mcp:after")).toEqual(["postToolUse"]);
    });

    it("returns empty array for unknown event", () => {
      expect(adapter.mapEvent("unknown:event" as HookEventType)).toEqual([]);
    });

    it("returns empty array for notification (not in Kiro event map)", () => {
      expect(adapter.mapEvent("notification" as HookEventType)).toEqual([]);
    });
  });

  // ── mapNativeEvent ─────────────────────────────────────────

  describe("mapNativeEvent", () => {
    it("maps agentSpawn to session:start", () => {
      expect(adapter.mapNativeEvent("agentSpawn")).toEqual(["session:start"]);
    });

    it("maps userPromptSubmit to prompt:submit", () => {
      expect(adapter.mapNativeEvent("userPromptSubmit")).toEqual(["prompt:submit"]);
    });

    it("maps preToolUse to multiple universal events", () => {
      const result = adapter.mapNativeEvent("preToolUse");
      expect(result).toEqual([
        "tool:before",
        "file:read",
        "file:write",
        "file:edit",
        "file:delete",
        "shell:before",
        "mcp:before",
      ]);
    });

    it("maps postToolUse to multiple universal events", () => {
      const result = adapter.mapNativeEvent("postToolUse");
      expect(result).toEqual(["tool:after", "shell:after", "mcp:after"]);
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
    it("returns two config files (runner + hooks JSON)", async () => {
      const configs = await adapter.generate([testHook]);
      expect(configs).toHaveLength(2);
    });

    it("generates runner script at correct path", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner).toBeDefined();
      expect(runner!.path).toBe(".kiro/hooks/ai-tools-hooks-runner.js");
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

    it("runner script reads STDIN for event data", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("readStdin");
      expect(runner!.content).toContain("process.stdin");
    });

    it("runner script reads hook_event_name from input", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("hook_event_name");
    });

    it("runner script reads tool_name from input", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("tool_name");
    });

    it("runner script reads tool_input from input", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("tool_input");
    });

    it("runner script handles agentSpawn event", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"agentSpawn"');
    });

    it("runner script handles userPromptSubmit event", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"userPromptSubmit"');
    });

    it("runner script handles preToolUse with tool routing", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("resolvePreToolEvent");
      expect(runner!.content).toContain("resolvePostToolEvent");
    });

    it("runner script handles fs_write and write tool names", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"fs_write"');
      expect(runner!.content).toContain('"write"');
    });

    it("runner script handles fs_edit and edit tool names", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"fs_edit"');
      expect(runner!.content).toContain('"edit"');
    });

    it("runner script handles fs_read and read tool names", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"fs_read"');
      expect(runner!.content).toContain('"read"');
    });

    it("runner script handles execute_bash and shell tool names", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"execute_bash"');
      expect(runner!.content).toContain('"shell"');
    });

    it("runner script handles stop event", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain('"stop"');
    });

    it("runner script handles blocking with exit code 2", async () => {
      const configs = await adapter.generate([testHook]);
      const runner = configs.find((c) => c.path.includes("runner"));
      expect(runner!.content).toContain("blocked");
      expect(runner!.content).toContain("process.exit(2)");
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

    it("hooks JSON command uses absolute path to runner", async () => {
      const configs = await adapter.generate([testHook]);
      const hooksJson = configs.find((c) => c.path.includes("ai-tools-hooks.json"));
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, Array<{ command: string }>>;
      };
      const firstEvent = Object.keys(parsed.hooks)[0]!;
      const command = parsed.hooks[firstEvent]![0]!.command;
      expect(command.startsWith("node ")).toBe(true);
      expect(isAbsolute(command.slice("node ".length))).toBe(true);
    });

    it("generates hooks JSON at correct path", async () => {
      const configs = await adapter.generate([testHook]);
      const hooksJson = configs.find((c) => c.path.includes("ai-tools-hooks.json"));
      expect(hooksJson).toBeDefined();
      expect(hooksJson!.path).toBe(".kiro/hooks/ai-tools-hooks.json");
    });

    it("hooks JSON has correct format", async () => {
      const configs = await adapter.generate([testHook]);
      const hooksJson = configs.find((c) => c.path.includes("ai-tools-hooks.json"));
      expect(hooksJson!.format).toBe("json");
    });

    it("hooks JSON contains valid JSON", async () => {
      const configs = await adapter.generate([testHook]);
      const hooksJson = configs.find((c) => c.path.includes("ai-tools-hooks.json"));
      const parsed = JSON.parse(hooksJson!.content) as Record<string, unknown>;
      expect(parsed).toBeDefined();
      expect(parsed.hooks).toBeDefined();
    });

    it("hooks JSON maps shell:before to preToolUse entry", async () => {
      const configs = await adapter.generate([testHook]);
      const hooksJson = configs.find((c) => c.path.includes("ai-tools-hooks.json"));
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, Array<{ command: string; matcher?: string }>>;
      };
      const preToolUse = parsed.hooks.preToolUse;
      expect(preToolUse).toBeDefined();
      expect(preToolUse).toHaveLength(1);
      expect(preToolUse![0]!.command).toContain("ai-tools-hooks-runner.js");
      expect(preToolUse![0]!.matcher).toBe("*");
    });

    it("preToolUse and postToolUse entries include wildcard matcher", async () => {
      const multiHook: HookDefinition = {
        id: "multi",
        name: "Multi Hook",
        events: ["tool:before", "tool:after"],
        phase: "before",
        handler: makeHandler(),
      };
      const configs = await adapter.generate([multiHook]);
      const hooksJson = configs.find((c) => c.path.includes("ai-tools-hooks.json"));
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, Array<{ command: string; matcher?: string }>>;
      };
      expect(parsed.hooks.preToolUse![0]!.matcher).toBe("*");
      expect(parsed.hooks.postToolUse![0]!.matcher).toBe("*");
    });

    it("non-tool events do not include matcher", async () => {
      const sessionHook: HookDefinition = {
        id: "session",
        name: "Session Hook",
        events: ["session:start"],
        phase: "before",
        handler: makeHandler(),
      };
      const configs = await adapter.generate([sessionHook]);
      const hooksJson = configs.find((c) => c.path.includes("ai-tools-hooks.json"));
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, Array<{ command: string; matcher?: string }>>;
      };
      const agentSpawn = parsed.hooks.agentSpawn;
      expect(agentSpawn).toBeDefined();
      expect(agentSpawn![0]!.matcher).toBeUndefined();
    });

    it("maps multiple hook events to correct native events", async () => {
      const multiHook: HookDefinition = {
        id: "multi",
        name: "Multi Hook",
        events: ["session:start", "tool:after", "session:end"],
        phase: "after",
        handler: makeHandler(),
      };
      const configs = await adapter.generate([multiHook]);
      const hooksJson = configs.find((c) => c.path.includes("ai-tools-hooks.json"));
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, unknown[]>;
      };
      expect(parsed.hooks.agentSpawn).toBeDefined();
      expect(parsed.hooks.postToolUse).toBeDefined();
      expect(parsed.hooks.stop).toBeDefined();
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
      const hooksJson = configs.find((c) => c.path.includes("ai-tools-hooks.json"));
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, unknown[]>;
      };
      // Both map to preToolUse, should only have one entry
      expect(parsed.hooks.preToolUse).toHaveLength(1);
    });

    it("returns empty hooks config for hooks with no native event mappings", async () => {
      const unmappedHook: HookDefinition = {
        id: "unmapped",
        name: "Unmapped Hook",
        events: ["notification" as HookEventType],
        phase: "after",
        handler: makeHandler(),
      };
      const configs = await adapter.generate([unmappedHook]);
      const hooksJson = configs.find((c) => c.path.includes("ai-tools-hooks.json"));
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, unknown[]>;
      };
      expect(Object.keys(parsed.hooks)).toHaveLength(0);
    });

    it("generates config for empty hooks array", async () => {
      const configs = await adapter.generate([]);
      expect(configs).toHaveLength(2);
      const hooksJson = configs.find((c) => c.path.includes("ai-tools-hooks.json"));
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
      const hooksJson = configs.find((c) => c.path.includes("ai-tools-hooks.json"));
      const parsed = JSON.parse(hooksJson!.content) as {
        hooks: Record<string, unknown[]>;
      };
      // Both map to stop, should only have one entry (deduplication)
      expect(parsed.hooks.stop).toHaveLength(1);
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
