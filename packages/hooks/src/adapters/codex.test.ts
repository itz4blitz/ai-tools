import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";
import { CodexAdapter } from "./codex.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-hooks-codex-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

describe("CodexAdapter", () => {
  let adapter: CodexAdapter;

  const testHook: HookDefinition = {
    id: "test",
    name: "Test Hook",
    events: ["shell:before"],
    phase: "before",
    handler: makeHandler(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    adapter = new CodexAdapter();
  });

  describe("metadata", () => {
    it("has correct id, name, and version", () => {
      expect(adapter.id).toBe("codex");
      expect(adapter.name).toBe("Codex");
      expect(adapter.version).toBe("1.0");
    });
  });

  describe("capabilities", () => {
    it("supports before/after hooks, MCP, configFile, and excludes dead file:delete", () => {
      expect(adapter.capabilities.beforeHooks).toBe(true);
      expect(adapter.capabilities.afterHooks).toBe(true);
      expect(adapter.capabilities.mcp).toBe(true);
      expect(adapter.capabilities.configFile).toBe(true);
      expect(adapter.capabilities.supportedEvents).toContain("session:end");
      expect(adapter.capabilities.supportedEvents).toContain("prompt:response");
      expect(adapter.capabilities.supportedEvents).not.toContain("file:delete");
      expect(adapter.capabilities.blockableEvents).toContain("prompt:submit");
      expect(adapter.capabilities.blockableEvents).toContain("shell:before");
      expect(adapter.capabilities.blockableEvents).not.toContain("file:delete");
    });
  });

  describe("mapEvent & mapNativeEvent", () => {
    it("maps session:end to SessionEnd and prompt:response to Stop", () => {
      expect(adapter.mapEvent("session:start")).toEqual(["SessionStart"]);
      expect(adapter.mapEvent("session:end")).toEqual(["SessionEnd"]);
      expect(adapter.mapEvent("prompt:submit")).toEqual(["UserPromptSubmit"]);
      expect(adapter.mapEvent("prompt:response")).toEqual(["Stop"]);
      expect(adapter.mapEvent("shell:before")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("shell:after")).toEqual(["PostToolUse"]);
      expect(adapter.mapEvent("file:delete")).toEqual([]);
      expect(adapter.mapEvent("notification" as HookEventType)).toEqual([]);
    });

    it("reverse maps native events accurately", () => {
      expect(adapter.mapNativeEvent("SessionStart")).toEqual(["session:start"]);
      expect(adapter.mapNativeEvent("SessionEnd")).toEqual(["session:end"]);
      expect(adapter.mapNativeEvent("Stop")).toEqual(["prompt:response"]);
      expect(adapter.mapNativeEvent("PreToolUse")).toEqual([
        "tool:before",
        "file:read",
        "file:write",
        "file:edit",
        "shell:before",
        "mcp:before",
      ]);
      expect(adapter.mapNativeEvent("PostToolUse")).toEqual([
        "tool:after",
        "shell:after",
        "mcp:after",
      ]);
    });
  });

  describe("generate", () => {
    it("generates valid JS runner with JSON-escaped Windows PROJECT_ROOT and quoted command path", async () => {
      const winPath = "C:\\Users\\test user\\my project";
      vi.spyOn(process, "cwd").mockReturnValue(winPath);

      const files = await adapter.generate([
        testHook,
        { ...testHook, id: "end", events: ["session:end"] },
      ]);
      expect(files).toHaveLength(2);
      expect(files[0]?.path).toBe(".codex/hooks/ai-tools-hooks-runner.js");
      expect(files[1]?.path).toBe(".codex/hooks.json");

      const runner = files[0]!.content;
      expect(runner).toContain("const PROJECT_ROOT = ");
      // Strip shebang and ESM import so vm.Script can syntax-check the generated JS
      const syntaxCheckSource = runner
        .replace(/^#!.*\n/, "")
        .replace(
          /^import .*$/m,
          "const loadConfig = async () => ({}); const HookEngine = class {};",
        );
      expect(() => new vm.Script(syntaxCheckSource)).not.toThrow();

      // Check Codex native shell tool names and SessionEnd handling in runner
      for (const toolName of ["shell", "exec_command", "shell_command", "local_shell"]) {
        expect(runner).toContain(`case "${toolName}":`);
      }
      expect(runner).toContain('case "SessionEnd":');

      const config = JSON.parse(files[1]!.content) as {
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      expect(config.hooks.PreToolUse).toHaveLength(1);
      expect(config.hooks.SessionEnd).toHaveLength(1);
      expect(config.hooks.PreToolUse![0]!.hooks[0]!.command).toMatch(
        /^node ".*ai-tools-hooks-runner\.js" PreToolUse$/,
      );
    });

    it("deduplicates native events shared by multiple universal events", async () => {
      const files = await adapter.generate([
        testHook,
        { ...testHook, id: "mcp", events: ["mcp:before"] },
      ]);
      const config = JSON.parse(files[1]!.content) as { hooks: Record<string, unknown[]> };
      expect(config.hooks.PreToolUse).toHaveLength(1);
    });
  });

  describe("install and uninstall", () => {
    it("merges into existing .codex/hooks.json on install and strips only ai-tools entries on uninstall", async () => {
      await withTempDir(async (dir) => {
        vi.spyOn(process, "cwd").mockReturnValue(dir);

        const hooksJsonPath = join(dir, ".codex", "hooks.json");
        await mkdir(join(dir, ".codex"), { recursive: true });
        await writeFile(
          hooksJsonPath,
          JSON.stringify(
            {
              customKey: true,
              hooks: {
                PreToolUse: [
                  {
                    matcher: "Bash",
                    hooks: [{ type: "command", command: "echo user-hook" }],
                  },
                ],
                Notification: [
                  {
                    hooks: [{ type: "command", command: "echo notify" }],
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

        expect(existsSync(join(dir, ".codex/hooks/ai-tools-hooks-runner.js"))).toBe(true);

        const installed = JSON.parse(await readFile(hooksJsonPath, "utf-8")) as {
          customKey?: boolean;
          hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
        };
        expect(installed.customKey).toBe(true);
        expect(installed.hooks.Notification).toHaveLength(1);
        expect(installed.hooks.PreToolUse).toHaveLength(2);
        expect(installed.hooks.PreToolUse![0]!.hooks[0]!.command).toBe("echo user-hook");
        expect(installed.hooks.PreToolUse![1]!.hooks[0]!.command).toContain(
          "ai-tools-hooks-runner.js",
        );

        // Re-install should not duplicate ai-tools entries
        await adapter.install(configs);
        const reinstalled = JSON.parse(await readFile(hooksJsonPath, "utf-8")) as {
          hooks: Record<string, unknown[]>;
        };
        expect(reinstalled.hooks.PreToolUse).toHaveLength(2);

        // Uninstall strips only ai-tools entries and keeps user hooks + customKey
        await adapter.uninstall();
        expect(existsSync(join(dir, ".codex/hooks/ai-tools-hooks-runner.js"))).toBe(false);
        expect(existsSync(hooksJsonPath)).toBe(true);

        const afterUninstall = JSON.parse(await readFile(hooksJsonPath, "utf-8")) as {
          customKey?: boolean;
          hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
        };
        expect(afterUninstall.customKey).toBe(true);
        expect(afterUninstall.hooks.PreToolUse).toHaveLength(1);
        expect(afterUninstall.hooks.PreToolUse![0]!.hooks[0]!.command).toBe("echo user-hook");
        expect(afterUninstall.hooks.Notification).toHaveLength(1);
      });
    });

    it("deletes .codex/hooks.json on uninstall when no user entries remain", async () => {
      await withTempDir(async (dir) => {
        vi.spyOn(process, "cwd").mockReturnValue(dir);

        const configs = await adapter.generate([testHook]);
        await adapter.install(configs);
        expect(existsSync(join(dir, ".codex/hooks.json"))).toBe(true);

        await adapter.uninstall();
        expect(existsSync(join(dir, ".codex/hooks.json"))).toBe(false);
      });
    });
  });

  describe("detect", () => {
    it("accepts cwd and returns true when .codex exists in that directory", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".codex"), { recursive: true });
        expect(await adapter.detect(dir)).toBe(true);
      });
    });
  });
});
