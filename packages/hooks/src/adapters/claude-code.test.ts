import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";
import { ClaudeCodeAdapter } from "./claude-code.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

const temps: string[] = [];
const originalCwd = process.cwd();

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-hooks-claude-"));
  temps.push(dir);
  return dir;
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
    adapter = new ClaudeCodeAdapter();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe("metadata & capabilities", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("claude-code");
      expect(adapter.name).toBe("Claude Code");
      expect(adapter.version).toBe("1.0");
    });

    it("supports before/after hooks, mcp, configFile, and prompt:response", () => {
      expect(adapter.capabilities.beforeHooks).toBe(true);
      expect(adapter.capabilities.afterHooks).toBe(true);
      expect(adapter.capabilities.mcp).toBe(true);
      expect(adapter.capabilities.configFile).toBe(true);
      expect(adapter.capabilities.supportedEvents).toContain("prompt:response");
      for (const event of adapter.capabilities.blockableEvents) {
        expect(adapter.capabilities.supportedEvents).toContain(event);
      }
    });
  });

  describe("mapEvent & mapNativeEvent", () => {
    it("maps universal events to Claude Code native events", () => {
      expect(adapter.mapEvent("session:start")).toEqual(["SessionStart"]);
      expect(adapter.mapEvent("session:end")).toEqual(["SessionEnd"]);
      expect(adapter.mapEvent("prompt:submit")).toEqual(["UserPromptSubmit"]);
      expect(adapter.mapEvent("prompt:response")).toEqual(["Stop"]);
      expect(adapter.mapEvent("tool:before")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("tool:after")).toEqual(["PostToolUse"]);
      expect(adapter.mapEvent("file:read")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("file:write")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("file:edit")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("file:delete")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("shell:before")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("shell:after")).toEqual(["PostToolUse"]);
      expect(adapter.mapEvent("mcp:before")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("mcp:after")).toEqual(["PostToolUse"]);
      expect(adapter.mapEvent("notification")).toEqual(["Notification"]);
      expect(adapter.mapEvent("unknown:event" as HookEventType)).toEqual([]);
    });

    it("maps native events including PermissionRequest, PostToolUseFailure, SubagentStart, SubagentStop, PreCompact", () => {
      expect(adapter.mapNativeEvent("SessionStart")).toEqual(["session:start"]);
      expect(adapter.mapNativeEvent("SessionEnd")).toEqual(["session:end"]);
      expect(adapter.mapNativeEvent("UserPromptSubmit")).toEqual(["prompt:submit"]);
      expect(adapter.mapNativeEvent("Stop")).toEqual(["prompt:response"]);
      expect(adapter.mapNativeEvent("PreToolUse")).toContain("file:read");
      expect(adapter.mapNativeEvent("PermissionRequest")).toEqual([
        "tool:before",
        "shell:before",
        "mcp:before",
      ]);
      expect(adapter.mapNativeEvent("PostToolUseFailure")).toEqual([
        "tool:after",
        "shell:after",
        "mcp:after",
      ]);
      expect(adapter.mapNativeEvent("SubagentStart")).toEqual(["session:start"]);
      expect(adapter.mapNativeEvent("SubagentStop")).toEqual(["session:end"]);
      expect(adapter.mapNativeEvent("PreCompact")).toEqual(["notification"]);
      expect(adapter.mapNativeEvent("Notification")).toEqual(["notification"]);
      expect(adapter.mapNativeEvent("Unknown")).toEqual([]);
    });
  });

  describe("generate, install, import, uninstall roundtrip", () => {
    it("generates Windows-safe runner delegating to runClaudeCodeHook and quoted $CLAUDE_PROJECT_DIR command", async () => {
      const dir = await tempDir();
      process.chdir(dir);

      const configs = await adapter.generate([testHook]);
      expect(configs).toHaveLength(2);

      const runner = configs.find((c) => c.path === ".claude/hooks/ai-tools-hooks-runner.js");
      expect(runner).toBeDefined();
      expect(runner!.content).toContain(
        'import { runClaudeCodeHook } from "@itz4blitz/ai-tools-hooks";',
      );
      expect(runner!.content).toContain(`const PROJECT_ROOT = ${JSON.stringify(process.cwd())};`);
      expect(runner!.content).not.toContain("process.env.CLAUDE_HOOK_EVENT");

      // Validate that PROJECT_ROOT line is a valid JSON-escaped JS string literal even on Windows paths
      const projectRootLine = runner!.content
        .split("\n")
        .find((line) => line.startsWith("const PROJECT_ROOT ="));
      expect(projectRootLine).toBeDefined();
      const literal = projectRootLine!.slice("const PROJECT_ROOT = ".length, -1);
      expect(JSON.parse(literal)).toBe(process.cwd());

      const settings = configs.find((c) => c.path === ".claude/settings.json");
      expect(settings).toBeDefined();
      const parsed = JSON.parse(settings!.content) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string; description: string }> }>>;
      };
      expect(parsed.hooks.PreToolUse).toHaveLength(1);
      expect(parsed.hooks.PreToolUse![0]!.hooks[0]!.command).toBe(
        'node "${CLAUDE_PROJECT_DIR:-.}/.claude/hooks/ai-tools-hooks-runner.js"',
      );
      expect(parsed.hooks.PreToolUse![0]!.hooks[0]!.description).toBe("ai-hooks: PreToolUse");
    });

    it("strips stale ai-hooks entries across ALL keys on generate and uninstall while preserving user hooks", async () => {
      const dir = await tempDir();
      process.chdir(dir);

      await mkdir(join(dir, ".claude"), { recursive: true });
      await writeFile(
        join(dir, ".claude/settings.json"),
        JSON.stringify(
          {
            theme: "dark",
            hooks: {
              Stop: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: "node old-runner.js",
                      description: "ai-hooks: Stop",
                    },
                  ],
                },
              ],
              SessionStart: [
                {
                  hooks: [
                    {
                      type: "command",
                      command: "echo user-start",
                      description: "custom user hook",
                    },
                  ],
                },
                {
                  hooks: [
                    {
                      type: "command",
                      command: "node .claude/hooks/ai-tools-hooks-runner.js",
                      description: "ai-hooks: SessionStart",
                    },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const configs = await adapter.generate([testHook]);
      await adapter.install(configs);

      const afterInstall = JSON.parse(
        await readFile(join(dir, ".claude/settings.json"), "utf-8"),
      ) as {
        theme: string;
        hooks: Record<string, Array<{ hooks: Array<{ command: string; description?: string }> }>>;
      };

      expect(afterInstall.theme).toBe("dark");
      // Stale Stop key should be completely stripped
      expect(afterInstall.hooks.Stop).toBeUndefined();
      // SessionStart should keep only the custom user hook
      expect(afterInstall.hooks.SessionStart).toHaveLength(1);
      expect(afterInstall.hooks.SessionStart![0]!.hooks[0]!.command).toBe("echo user-start");
      // PreToolUse should have the fresh ai-hooks entry
      expect(afterInstall.hooks.PreToolUse).toHaveLength(1);

      // Import should return both the user hook and the installed ai-hooks entry
      const imported = await adapter.import(dir);
      expect(imported.some((h) => h.name === "echo user-start")).toBe(true);
      expect(imported.some((h) => h.name.includes("ai-tools-hooks-runner.js"))).toBe(true);

      // Uninstall should remove runner and strip ai-hooks entries while preserving user hook
      await adapter.uninstall();
      expect(existsSync(join(dir, ".claude/hooks/ai-tools-hooks-runner.js"))).toBe(false);

      const afterUninstall = JSON.parse(
        await readFile(join(dir, ".claude/settings.json"), "utf-8"),
      ) as {
        theme: string;
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      expect(afterUninstall.theme).toBe("dark");
      expect(afterUninstall.hooks.PreToolUse).toBeUndefined();
      expect(afterUninstall.hooks.SessionStart).toHaveLength(1);
      expect(afterUninstall.hooks.SessionStart![0]!.hooks[0]!.command).toBe("echo user-start");
    });

    it("imports user hooks via importUser()", async () => {
      const dir = await tempDir();
      const userSettings = join(dir, "settings.json");
      await writeFile(
        userSettings,
        JSON.stringify({
          hooks: {
            SessionEnd: [{ hooks: [{ type: "command", command: "echo bye" }] }],
          },
        }),
        "utf-8",
      );

      Object.defineProperty(adapter, "userSettingsPath", { value: userSettings });
      const imported = await adapter.importUser();
      expect(imported).toHaveLength(1);
      expect(imported[0]!.events).toEqual(["session:end"]);
      expect(imported[0]!.name).toBe("echo bye");
    });

    it("detect(cwd) checks the provided directory", async () => {
      const dir = await tempDir();
      await mkdir(join(dir, ".claude"), { recursive: true });
      expect(await adapter.detect(dir)).toBe(true);
    });
  });
});
