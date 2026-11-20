import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";
import { KiroAdapter } from "./kiro.js";

const execFileAsync = promisify(execFile);

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

type KiroV1Config = {
  version: string;
  hooks: Array<{
    name: string;
    trigger: string;
    matcher?: string;
    action: { type: string; command: string };
    enabled: boolean;
  }>;
};

describe("KiroAdapter", () => {
  let adapter: KiroAdapter;
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
    adapter = new KiroAdapter();
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "kiro-hooks-test-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata & capabilities", () => {
    it("has correct id, name, version, and capabilities", () => {
      expect(adapter.id).toBe("kiro");
      expect(adapter.name).toBe("Kiro CLI");
      expect(adapter.version).toBe("1.0");
      expect(adapter.capabilities.beforeHooks).toBe(true);
      expect(adapter.capabilities.afterHooks).toBe(true);
      expect(adapter.capabilities.mcp).toBe(true);
      expect(adapter.capabilities.configFile).toBe(true);
      expect(adapter.capabilities.blockableEvents).toContain("prompt:submit");
      for (const event of adapter.capabilities.blockableEvents) {
        expect(adapter.capabilities.supportedEvents).toContain(event);
      }
    });
  });

  describe("mapEvent & mapNativeEvent", () => {
    it("maps universal events to Kiro native triggers", () => {
      expect(adapter.mapEvent("session:start")).toEqual(["agentSpawn"]);
      expect(adapter.mapEvent("session:end")).toEqual(["stop"]);
      expect(adapter.mapEvent("prompt:submit")).toEqual(["userPromptSubmit"]);
      expect(adapter.mapEvent("prompt:response")).toEqual(["stop"]);
      expect(adapter.mapEvent("tool:before")).toEqual(["preToolUse"]);
      expect(adapter.mapEvent("tool:after")).toEqual(["postToolUse"]);
      expect(adapter.mapEvent("file:delete")).toEqual(["preToolUse"]);
      expect(adapter.mapEvent("mcp:before")).toEqual(["preToolUse"]);
      expect(adapter.mapEvent("mcp:after")).toEqual(["postToolUse"]);
      expect(adapter.mapEvent("notification" as HookEventType)).toEqual([]);
    });

    it("maps both camelCase and PascalCase native events", () => {
      expect(adapter.mapNativeEvent("agentSpawn")).toEqual(["session:start"]);
      expect(adapter.mapNativeEvent("AgentSpawn")).toEqual(["session:start"]);
      expect(adapter.mapNativeEvent("userPromptSubmit")).toEqual(["prompt:submit"]);
      expect(adapter.mapNativeEvent("UserPromptSubmit")).toEqual(["prompt:submit"]);
      expect(adapter.mapNativeEvent("preToolUse")).toContain("file:delete");
      expect(adapter.mapNativeEvent("PreToolUse")).toContain("mcp:before");
      expect(adapter.mapNativeEvent("postToolUse")).toContain("mcp:after");
      expect(adapter.mapNativeEvent("PostToolUse")).toContain("shell:after");
      expect(adapter.mapNativeEvent("stop")).toEqual(["session:end", "prompt:response"]);
      expect(adapter.mapNativeEvent("Stop")).toEqual(["session:end", "prompt:response"]);
      expect(adapter.mapNativeEvent("Unknown")).toEqual([]);
    });
  });

  describe("generate (v1 schema & Windows-safe runner)", () => {
    it("emits valid standalone Kiro v1 hook JSON with quoted runner path", async () => {
      const hooks: HookDefinition[] = [
        {
          id: "multi",
          name: "Multi",
          events: ["session:start", "prompt:submit", "tool:before", "tool:after", "session:end"],
          phase: "before",
          handler: makeHandler(),
        },
      ];

      const configs = await adapter.generate(hooks);
      expect(configs).toHaveLength(2);

      const hooksJson = configs.find((c) => c.path === ".kiro/hooks/ai-tools-hooks.json");
      expect(hooksJson).toBeDefined();
      expect(hooksJson!.format).toBe("json");

      const parsed = JSON.parse(hooksJson!.content) as KiroV1Config;
      expect(parsed.version).toBe("v1");
      expect(Array.isArray(parsed.hooks)).toBe(true);
      expect(parsed.hooks).toHaveLength(5);

      for (const entry of parsed.hooks) {
        expect(entry.enabled).toBe(true);
        expect(entry.name).toBe(`ai-tools-${entry.trigger}`);
        expect(entry.action.type).toBe("command");
        expect(entry.action.command).toMatch(/^node ".*"$/);
        const unquoted = entry.action.command.slice('node "'.length, -1);
        expect(isAbsolute(unquoted)).toBe(true);
        expect(unquoted).toContain("ai-tools-hooks-runner.js");
      }

      const pre = parsed.hooks.find((h) => h.trigger === "preToolUse");
      const post = parsed.hooks.find((h) => h.trigger === "postToolUse");
      const spawn = parsed.hooks.find((h) => h.trigger === "agentSpawn");
      expect(pre?.matcher).toBe("*");
      expect(post?.matcher).toBe("*");
      expect(spawn?.matcher).toBeUndefined();
    });

    it("deduplicates triggers when multiple hooks map to the same native event", async () => {
      const hooks: HookDefinition[] = [
        {
          id: "h1",
          name: "H1",
          events: ["tool:before", "session:end"],
          phase: "before",
          handler: makeHandler(),
        },
        {
          id: "h2",
          name: "H2",
          events: ["file:delete", "prompt:response"],
          phase: "after",
          handler: makeHandler(),
        },
      ];
      const configs = await adapter.generate(hooks);
      const hooksJson = configs.find((c) => c.path === ".kiro/hooks/ai-tools-hooks.json");
      const parsed = JSON.parse(hooksJson!.content) as KiroV1Config;
      expect(parsed.hooks.map((h) => h.trigger)).toEqual(["preToolUse", "stop"]);
    });

    it("generates syntactically valid runner JS with JSON-escaped PROJECT_ROOT and full event dispatch", async () => {
      const configs = await adapter.generate([testHook]);
      await adapter.install(configs);

      const runnerPath = join(tempDir, ".kiro", "hooks", "ai-tools-hooks-runner.js");
      const runnerCode = await readFile(runnerPath, "utf-8");

      expect(runnerCode).toContain(`const PROJECT_ROOT = ${JSON.stringify(process.cwd())};`);
      expect(runnerCode).toContain('case "AgentSpawn":');
      expect(runnerCode).toContain('case "UserPromptSubmit":');
      expect(runnerCode).toContain('case "PreToolUse":');
      expect(runnerCode).toContain('case "PostToolUse":');
      expect(runnerCode).toContain('case "Stop":');
      expect(runnerCode).toContain("input.prompt ?? toolInput.prompt");
      expect(runnerCode).toContain('type: "mcp:before"');
      expect(runnerCode).toContain('type: "mcp:after"');
      expect(runnerCode).toContain('type: "file:delete"');
      expect(runnerCode).toContain('type: "prompt:response"');

      // Validate syntax with node --check (catches unescaped Windows backslashes in PROJECT_ROOT)
      await expect(execFileAsync(process.execPath, ["--check", runnerPath])).resolves.toBeDefined();
    });
  });

  describe("detect & uninstall", () => {
    it("detects .kiro directory and falls back to kiro / kiro-cli commands", async () => {
      const spy = vi
        .spyOn(
          adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
          "commandExists",
        )
        .mockImplementation(async (cmd) => cmd === "kiro-cli");

      expect(await adapter.detect()).toBe(true);
      expect(spy).toHaveBeenCalledWith("kiro");
      expect(spy).toHaveBeenCalledWith("kiro-cli");

      spy.mockResolvedValue(false);
      expect(await adapter.detect()).toBe(false);

      await mkdir(join(tempDir, ".kiro"), { recursive: true });
      expect(await adapter.detect()).toBe(true);
    });

    it("installs and uninstalls generated files in temp dir", async () => {
      const configs = await adapter.generate([testHook]);
      await adapter.install(configs);

      const runnerFile = join(tempDir, ".kiro", "hooks", "ai-tools-hooks-runner.js");
      const hooksFile = join(tempDir, ".kiro", "hooks", "ai-tools-hooks.json");
      expect(existsSync(runnerFile)).toBe(true);
      expect(existsSync(hooksFile)).toBe(true);

      await adapter.uninstall();
      expect(existsSync(runnerFile)).toBe(false);
      expect(existsSync(hooksFile)).toBe(false);
    });
  });
});
