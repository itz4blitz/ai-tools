import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";
import { CopilotAdapter } from "./copilot.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

describe("CopilotAdapter", () => {
  let adapter: CopilotAdapter;
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
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-copilot-hooks-"));
    process.chdir(tempDir);
    adapter = new CopilotAdapter();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("metadata & capabilities", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("copilot");
      expect(adapter.name).toBe("Copilot");
      expect(adapter.version).toBe("1.0");
    });

    it("declares full lifecycle capabilities", () => {
      expect(adapter.capabilities.beforeHooks).toBe(true);
      expect(adapter.capabilities.afterHooks).toBe(true);
      expect(adapter.capabilities.mcp).toBe(true);
      expect(adapter.capabilities.configFile).toBe(true);
      expect(adapter.capabilities.supportedEvents).toContain("session:start");
      expect(adapter.capabilities.supportedEvents).toContain("session:end");
      expect(adapter.capabilities.supportedEvents).toContain("prompt:submit");
      expect(adapter.capabilities.supportedEvents).toContain("prompt:response");
      expect(adapter.capabilities.blockableEvents).toContain("shell:before");
      expect(adapter.capabilities.blockableEvents).toContain("prompt:submit");
    });
  });

  describe("event mapping", () => {
    it("maps universal events to Copilot native events", () => {
      expect(adapter.mapEvent("session:start")).toEqual(["sessionStart"]);
      expect(adapter.mapEvent("session:end")).toEqual(["sessionEnd"]);
      expect(adapter.mapEvent("prompt:submit")).toEqual(["userPromptSubmit"]);
      expect(adapter.mapEvent("prompt:response")).toEqual(["stop"]);
      expect(adapter.mapEvent("tool:before")).toEqual(["preToolUse"]);
      expect(adapter.mapEvent("tool:after")).toEqual(["postToolUse"]);
      expect(adapter.mapEvent("shell:before")).toEqual(["preToolUse"]);
      expect(adapter.mapEvent("shell:after")).toEqual(["postToolUse"]);
      expect(adapter.mapEvent("mcp:before")).toEqual(["preToolUse"]);
      expect(adapter.mapEvent("mcp:after")).toEqual(["postToolUse"]);
      expect(adapter.mapEvent("notification" as HookEventType)).toEqual([]);
    });

    it("maps Copilot native events back to universal events", () => {
      expect(adapter.mapNativeEvent("sessionStart")).toEqual(["session:start"]);
      expect(adapter.mapNativeEvent("userPromptSubmit")).toEqual(["prompt:submit"]);
      expect(adapter.mapNativeEvent("preToolUse")).toContain("shell:before");
      expect(adapter.mapNativeEvent("postToolUse")).toContain("shell:after");
      expect(adapter.mapNativeEvent("stop")).toEqual(["prompt:response", "session:end"]);
      expect(adapter.mapNativeEvent("sessionEnd")).toEqual(["session:end"]);
      expect(adapter.mapNativeEvent("unknown")).toEqual([]);
    });
  });

  describe("generate, install, and uninstall", () => {
    it("generates runner and versioned hooks json with timeout 30", async () => {
      const files = await adapter.generate([
        testHook,
        { ...testHook, id: "start", events: ["session:start"] },
        { ...testHook, id: "prompt", events: ["prompt:submit"] },
        { ...testHook, id: "after", events: ["tool:after"] },
        { ...testHook, id: "end", events: ["session:end", "prompt:response"] },
      ]);

      expect(files).toHaveLength(2);
      expect(files[0]?.path).toBe(".github/hooks/ai-tools-hooks-runner.js");
      expect(files[1]?.path).toBe(".github/hooks/ai-tools-hooks.json");

      const config = JSON.parse(files[1]!.content);
      expect(config.version).toBe(1);
      expect(config.hooks.preToolUse).toHaveLength(1);
      expect(config.hooks.preToolUse[0]).toMatchObject({
        type: "command",
        timeout: 30,
      });
      expect(config.hooks.preToolUse[0].command).toContain("ai-tools-hooks-runner.js");
      expect(config.hooks.sessionStart).toHaveLength(1);
      expect(config.hooks.userPromptSubmit).toHaveLength(1);
      expect(config.hooks.postToolUse).toHaveLength(1);
      expect(config.hooks.stop).toHaveLength(1);
      expect(config.hooks.sessionEnd).toHaveLength(1);
    });

    it("uses JSON.stringify for PROJECT_ROOT and returns permissionDecision deny on block", async () => {
      const files = await adapter.generate([testHook]);
      const runner = files[0]!.content;
      expect(runner).toContain(`const PROJECT_ROOT = ${JSON.stringify(process.cwd())};`);
      expect(runner).toContain("hookSpecificOutput");
      expect(runner).toContain('permissionDecision: "deny"');
      expect(runner).toContain("readStdin");
    });

    it("installs and uninstalls generated files in a real temp dir", async () => {
      const files = await adapter.generate([testHook]);
      await adapter.install(files);

      const runnerPath = join(tempDir, ".github/hooks/ai-tools-hooks-runner.js");
      const configPath = join(tempDir, ".github/hooks/ai-tools-hooks.json");
      expect(existsSync(runnerPath)).toBe(true);
      expect(existsSync(configPath)).toBe(true);

      const saved = JSON.parse(await readFile(configPath, "utf-8"));
      expect(saved.version).toBe(1);
      expect(saved.hooks.preToolUse).toHaveLength(1);

      await adapter.uninstall();
      expect(existsSync(runnerPath)).toBe(false);
      expect(existsSync(configPath)).toBe(false);
    });
  });

  describe("detect", () => {
    it("returns true when .github/hooks directory exists", async () => {
      await mkdir(join(tempDir, ".github/hooks"), { recursive: true });
      vi.spyOn(
        adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
        "commandExists",
      ).mockResolvedValue(false);

      expect(await adapter.detect()).toBe(true);
    });

    it("returns true when copilot or code CLI is on PATH", async () => {
      const spy = vi
        .spyOn(
          adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
          "commandExists",
        )
        .mockImplementation(async (cmd) => cmd === "code");

      expect(await adapter.detect()).toBe(true);
      expect(spy).toHaveBeenCalledWith("copilot");
      expect(spy).toHaveBeenCalledWith("code");
    });

    it("returns false when neither dir nor CLIs exist", async () => {
      vi.spyOn(
        adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
        "commandExists",
      ).mockResolvedValue(false);

      expect(await adapter.detect()).toBe(false);
    });
  });
});
