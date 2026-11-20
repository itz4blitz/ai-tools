import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";
import { GeminiCliAdapter } from "./gemini-cli.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

describe("GeminiCliAdapter", () => {
  let adapter: GeminiCliAdapter;
  let tempDir: string;
  let originalCwd: string;

  const testHook: HookDefinition = {
    id: "test",
    name: "Test Hook",
    events: ["shell:before"],
    phase: "before",
    handler: makeHandler(),
  };

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-gemini-hooks-"));
    process.chdir(tempDir);
    adapter = new GeminiCliAdapter();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata & capabilities", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("gemini-cli");
      expect(adapter.name).toBe("Gemini CLI");
      expect(adapter.version).toBe("1.0");
    });

    it("lists all supported and blockable events including file:read and notification", () => {
      expect(adapter.capabilities.beforeHooks).toBe(true);
      expect(adapter.capabilities.afterHooks).toBe(true);
      expect(adapter.capabilities.mcp).toBe(true);
      expect(adapter.capabilities.configFile).toBe(true);
      expect(adapter.capabilities.supportedEvents).toContain("file:read");
      expect(adapter.capabilities.supportedEvents).toContain("notification");
      for (const event of adapter.capabilities.blockableEvents) {
        expect(adapter.capabilities.supportedEvents).toContain(event);
      }
    });
  });

  describe("event mapping", () => {
    it("maps universal events to real Gemini CLI events", () => {
      expect(adapter.mapEvent("session:start")).toEqual(["SessionStart"]);
      expect(adapter.mapEvent("session:end")).toEqual(["SessionEnd"]);
      expect(adapter.mapEvent("prompt:submit")).toEqual(["BeforeAgent"]);
      expect(adapter.mapEvent("prompt:response")).toEqual(["AfterAgent"]);
      expect(adapter.mapEvent("tool:before")).toEqual(["BeforeTool"]);
      expect(adapter.mapEvent("tool:after")).toEqual(["AfterTool"]);
      expect(adapter.mapEvent("file:read")).toEqual(["BeforeTool"]);
      expect(adapter.mapEvent("file:write")).toEqual(["BeforeTool"]);
      expect(adapter.mapEvent("file:edit")).toEqual(["BeforeTool"]);
      expect(adapter.mapEvent("file:delete")).toEqual(["BeforeTool"]);
      expect(adapter.mapEvent("shell:before")).toEqual(["BeforeTool"]);
      expect(adapter.mapEvent("shell:after")).toEqual(["AfterTool"]);
      expect(adapter.mapEvent("mcp:before")).toEqual(["BeforeTool"]);
      expect(adapter.mapEvent("mcp:after")).toEqual(["AfterTool"]);
      expect(adapter.mapEvent("notification")).toEqual(["Notification"]);
      expect(adapter.mapEvent("unknown:event" as HookEventType)).toEqual([]);
    });

    it("maps real Gemini CLI native events back to universal events", () => {
      expect(adapter.mapNativeEvent("SessionStart")).toEqual(["session:start"]);
      expect(adapter.mapNativeEvent("SessionEnd")).toEqual(["session:end"]);
      expect(adapter.mapNativeEvent("BeforeAgent")).toEqual(["prompt:submit"]);
      expect(adapter.mapNativeEvent("AfterAgent")).toEqual(["prompt:response"]);
      expect(adapter.mapNativeEvent("BeforeTool")).toEqual([
        "tool:before",
        "file:read",
        "file:write",
        "file:edit",
        "file:delete",
        "shell:before",
        "mcp:before",
      ]);
      expect(adapter.mapNativeEvent("AfterTool")).toEqual([
        "tool:after",
        "shell:after",
        "mcp:after",
      ]);
      expect(adapter.mapNativeEvent("Notification")).toEqual(["notification"]);
      expect(adapter.mapNativeEvent("BeforePrompt")).toEqual([]);
      expect(adapter.mapNativeEvent("BeforeShell")).toEqual([]);
    });
  });

  describe("generate, install, and uninstall", () => {
    it("generates ai-tools-runner.js with safely escaped PROJECT_ROOT and settings.json", async () => {
      const configs = await adapter.generate([
        testHook,
        {
          id: "prompt-guard",
          name: "Prompt Guard",
          events: ["prompt:submit", "notification"],
          phase: "before",
          handler: makeHandler(),
        },
      ]);

      expect(configs).toHaveLength(2);
      const runner = configs.find((c) => c.path === ".gemini/hooks/ai-tools-runner.js");
      const settings = configs.find((c) => c.path === ".gemini/settings.json");

      expect(runner).toBeDefined();
      expect(runner!.content).toContain("runGeminiHook");
      expect(runner!.content).toContain(
        `const PROJECT_ROOT = ${JSON.stringify(resolve(process.cwd()))};`,
      );
      expect(runner!.content).not.toContain("GEMINI_HOOK_INPUT");

      expect(settings).toBeDefined();
      const parsed = JSON.parse(settings!.content) as {
        hooks: Record<
          string,
          Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
        >;
      };
      expect(parsed.hooks.BeforeTool).toEqual([
        {
          matcher: "*",
          hooks: [{ type: "command", command: "node .gemini/hooks/ai-tools-runner.js" }],
        },
      ]);
      expect(parsed.hooks.BeforeAgent).toEqual([
        {
          hooks: [{ type: "command", command: "node .gemini/hooks/ai-tools-runner.js" }],
        },
      ]);
      expect(parsed.hooks.Notification).toEqual([
        {
          hooks: [{ type: "command", command: "node .gemini/hooks/ai-tools-runner.js" }],
        },
      ]);
    });

    it("merges non-destructively into existing .gemini/settings.json and strips only ai-tools entries on uninstall", async () => {
      await mkdir(join(tempDir, ".gemini"), { recursive: true });
      await writeFile(
        join(tempDir, ".gemini", "settings.json"),
        JSON.stringify(
          {
            theme: "Default",
            security: { auth: { selectedType: "oauth-personal" } },
            mcpServers: { linear: { command: "npx" } },
            hooks: {
              BeforeTool: [
                {
                  matcher: "write_file",
                  hooks: [{ type: "command", command: "node scripts/custom-hook.js" }],
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

      expect(existsSync(join(tempDir, ".gemini", "hooks", "ai-tools-runner.js"))).toBe(true);

      const afterInstall = JSON.parse(
        await readFile(join(tempDir, ".gemini", "settings.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(afterInstall.theme).toBe("Default");
      expect(afterInstall.security).toEqual({ auth: { selectedType: "oauth-personal" } });
      expect(afterInstall.mcpServers).toEqual({ linear: { command: "npx" } });

      const beforeToolGroups = (afterInstall.hooks as Record<string, unknown[]>).BeforeTool;
      expect(beforeToolGroups).toHaveLength(2);

      // Uninstall should remove runner and strip only ai-tools-runner.js
      await adapter.uninstall();
      expect(existsSync(join(tempDir, ".gemini", "hooks", "ai-tools-runner.js"))).toBe(false);

      const afterUninstall = JSON.parse(
        await readFile(join(tempDir, ".gemini", "settings.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(afterUninstall.theme).toBe("Default");
      expect(afterUninstall.security).toEqual({ auth: { selectedType: "oauth-personal" } });
      expect(afterUninstall.mcpServers).toEqual({ linear: { command: "npx" } });
      expect((afterUninstall.hooks as Record<string, unknown[]>).BeforeTool).toEqual([
        {
          matcher: "write_file",
          hooks: [{ type: "command", command: "node scripts/custom-hook.js" }],
        },
      ]);
    });
  });

  describe("import and detect", () => {
    it("imports hooks from project .gemini/settings.json", async () => {
      await mkdir(join(tempDir, ".gemini"), { recursive: true });
      await writeFile(
        join(tempDir, ".gemini", "settings.json"),
        JSON.stringify({
          hooks: {
            BeforeTool: [
              {
                matcher: "*",
                hooks: [{ type: "command", command: "node .gemini/hooks/ai-tools-runner.js" }],
              },
            ],
            AfterAgent: [
              {
                hooks: [{ type: "command", command: "node log-response.js" }],
              },
            ],
          },
        }),
        "utf-8",
      );

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(2);
      expect(imported[0]?.phase).toBe("before");
      expect(imported[0]?.events).toContain("shell:before");
      expect(imported[1]?.phase).toBe("after");
      expect(imported[1]?.events).toEqual(["prompt:response"]);
    });

    it("detects .gemini directory when cwd is provided", async () => {
      await mkdir(join(tempDir, ".gemini"), { recursive: true });
      expect(await adapter.detect(tempDir)).toBe(true);
    });
  });
});
