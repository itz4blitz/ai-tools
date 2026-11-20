import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";

vi.mock("./index.js", async () => {
  const { BaseAdapter } = await import("./base.js");
  return { BaseAdapter, registry: { register: vi.fn() } };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], cb: (error: Error | null) => void) => {
      cb(new Error("not found"));
    }),
  };
});

import { DroidAdapter } from "./droid.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

describe("DroidAdapter", () => {
  let adapter: DroidAdapter;
  let tmp: string;
  let previousCwd: string;

  const testHook: HookDefinition = {
    id: "test",
    name: "Test Hook",
    events: ["shell:before"],
    phase: "before",
    handler: makeHandler(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "ai-tools-droid-hooks-"));
    previousCwd = process.cwd();
    process.chdir(tmp);
    adapter = new DroidAdapter();
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  describe("metadata & capabilities", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("droid");
      expect(adapter.name).toBe("Factory Droid");
      expect(adapter.version).toBe("1.0");
    });

    it("includes prompt:submit and prompt:response in blockableEvents", () => {
      expect(adapter.capabilities.blockableEvents).toContain("prompt:submit");
      expect(adapter.capabilities.blockableEvents).toContain("prompt:response");
      for (const event of adapter.capabilities.blockableEvents) {
        expect(adapter.capabilities.supportedEvents).toContain(event);
      }
    });
  });

  describe("event mapping", () => {
    it("maps universal events to Factory Droid native events", () => {
      expect(adapter.mapEvent("session:start")).toEqual(["SessionStart"]);
      expect(adapter.mapEvent("session:end")).toEqual(["SessionEnd"]);
      expect(adapter.mapEvent("prompt:submit")).toEqual(["UserPromptSubmit"]);
      expect(adapter.mapEvent("prompt:response")).toEqual(["Stop"]);
      expect(adapter.mapEvent("shell:before")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("shell:after")).toEqual(["PostToolUse"]);
      expect(adapter.mapEvent("mcp:before")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("mcp:after")).toEqual(["PostToolUse"]);
      expect(adapter.mapEvent("notification")).toEqual(["Notification"]);
      expect(adapter.mapEvent("unknown:event" as HookEventType)).toEqual([]);
    });

    it("maps native events back to universal events", () => {
      expect(adapter.mapNativeEvent("Stop")).toEqual(["prompt:response"]);
      expect(adapter.mapNativeEvent("UserPromptSubmit")).toEqual(["prompt:submit"]);
      expect(adapter.mapNativeEvent("PreToolUse")).toContain("mcp:before");
      expect(adapter.mapNativeEvent("PostToolUse")).toContain("mcp:after");
      expect(adapter.mapNativeEvent("Unknown")).toEqual([]);
    });
  });

  describe("detect", () => {
    it("accepts optional cwd and detects .factory directory", async () => {
      const otherDir = await mkdtemp(join(tmpdir(), "ai-tools-droid-detect-"));
      try {
        expect(await adapter.detect(otherDir)).toBe(false);
        await mkdir(join(otherDir, ".factory"));
        expect(await adapter.detect(otherDir)).toBe(true);
      } finally {
        await rm(otherDir, { recursive: true, force: true });
      }
    });
  });

  describe("generate, mergeSettings & uninstall", () => {
    it("writes runner with JSON.stringify PROJECT_ROOT and quoted command in settings.json", async () => {
      const configs = await adapter.generate([testHook]);
      await adapter.install(configs);

      const runner = await readFile(join(tmp, ".factory/hooks/ai-tools-hooks-runner.js"), "utf-8");
      expect(runner).toContain(`const PROJECT_ROOT = ${JSON.stringify(resolve(tmp))};`);

      const settings = JSON.parse(await readFile(join(tmp, ".factory/settings.json"), "utf-8")) as {
        hooks: Record<
          string,
          Array<{
            matcher?: string;
            hooks: Array<{ type: string; command: string; timeout: number }>;
          }>
        >;
      };
      const expectedCmd = `node ${JSON.stringify(resolve(tmp, ".factory/hooks/ai-tools-hooks-runner.js"))}`;
      expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe("*");
      expect(settings.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe(expectedCmd);
    });

    it("prunes stale ai-tools entries across all event keys while preserving user settings and hooks", async () => {
      await mkdir(join(tmp, ".factory"), { recursive: true });
      await writeFile(
        join(tmp, ".factory/settings.json"),
        JSON.stringify({
          model: "claude-sonnet-4",
          hooks: {
            Notification: [
              { hooks: [{ type: "command", command: "node /old/ai-tools-hooks-runner.js" }] },
            ],
            Stop: [
              { hooks: [{ type: "command", command: "echo user-stop-hook" }] },
              { hooks: [{ type: "command", command: "node /legacy/ai-hooks-runner.js" }] },
            ],
          },
        }),
        "utf-8",
      );

      await adapter.install(await adapter.generate([testHook]));

      const settings = JSON.parse(await readFile(join(tmp, ".factory/settings.json"), "utf-8")) as {
        model: string;
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };

      expect(settings.model).toBe("claude-sonnet-4");
      expect(settings.hooks.Notification).toBeUndefined();
      expect(settings.hooks.Stop).toHaveLength(1);
      expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe("echo user-stop-hook");
      expect(settings.hooks.PreToolUse).toHaveLength(1);
    });

    it("handles corrupted existing settings.json gracefully without throwing", async () => {
      await mkdir(join(tmp, ".factory"), { recursive: true });
      await writeFile(join(tmp, ".factory/settings.json"), "{not-valid-json", "utf-8");

      const configs = await adapter.generate([testHook]);
      await adapter.install(configs);

      const settings = JSON.parse(await readFile(join(tmp, ".factory/settings.json"), "utf-8")) as {
        hooks: Record<string, unknown[]>;
      };
      expect(settings.hooks.PreToolUse).toHaveLength(1);
    });

    it("uninstall strips ai-tools entries from settings.json before removing runner scripts", async () => {
      await mkdir(join(tmp, ".factory/hooks"), { recursive: true });
      await writeFile(join(tmp, ".factory/hooks/ai-hooks-runner.js"), "// legacy", "utf-8");
      await writeFile(
        join(tmp, ".factory/settings.json"),
        JSON.stringify({
          theme: "dark",
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo keep-me" }] }],
          },
        }),
        "utf-8",
      );

      await adapter.install(await adapter.generate([testHook]));
      await adapter.uninstall();

      expect(existsSync(join(tmp, ".factory/hooks/ai-tools-hooks-runner.js"))).toBe(false);
      expect(existsSync(join(tmp, ".factory/hooks/ai-hooks-runner.js"))).toBe(false);

      const settings = JSON.parse(await readFile(join(tmp, ".factory/settings.json"), "utf-8")) as {
        theme: string;
        hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      };
      expect(settings.theme).toBe("dark");
      expect(settings.hooks.PreToolUse).toBeUndefined();
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe("echo keep-me");
    });
  });

  describe("runner execution", () => {
    async function setupRunnerMock(blockReason?: string): Promise<{
      runnerPath: string;
      outputFile: string;
    }> {
      await adapter.install(await adapter.generate([testHook]));
      await writeFile(
        join(tmp, "package.json"),
        JSON.stringify({ name: "droid-hook-test", type: "module" }),
        "utf-8",
      );
      const outputFile = join(tmp, "emitted-event.json");
      const mockPkgDir = join(tmp, "node_modules", "@itz4blitz", "ai-tools-hooks");
      await mkdir(mockPkgDir, { recursive: true });
      await writeFile(
        join(mockPkgDir, "package.json"),
        JSON.stringify({ name: "@itz4blitz/ai-tools-hooks", type: "module", main: "index.js" }),
        "utf-8",
      );
      await writeFile(
        join(mockPkgDir, "index.js"),
        `import { writeFileSync } from "node:fs";
export async function loadConfig() { return {}; }
export class HookEngine {
  async emit(event, toolInfo) {
    writeFileSync(${JSON.stringify(outputFile)}, JSON.stringify({ event, toolInfo }), "utf-8");
    return ${blockReason ? JSON.stringify([{ blocked: true, reason: blockReason }]) : "[]"};
  }
}
`,
        "utf-8",
      );
      return {
        runnerPath: join(tmp, ".factory/hooks/ai-tools-hooks-runner.js"),
        outputFile,
      };
    }

    function runRunner(runnerPath: string, payload: Record<string, unknown>) {
      return spawnSync(process.execPath, [runnerPath], {
        cwd: tmp,
        input: JSON.stringify(payload),
        encoding: "utf-8",
      });
    }

    it("maps Execute, Create, MultiEdit, ApplyPatch, Read, and mcp:* native Droid tools", async () => {
      const { runnerPath, outputFile } = await setupRunnerMock();

      // Execute -> shell:before with input.cwd
      let res = runRunner(runnerPath, {
        hook_event_name: "PreToolUse",
        sessionId: "sess-camel",
        cwd: "/repo/subdir",
        tool_name: "Execute",
        tool_input: { command: "npm test" },
      });
      expect(res.status, res.stderr).toBe(0);
      let recorded = JSON.parse(await readFile(outputFile, "utf-8")) as {
        event: Record<string, unknown>;
      };
      expect(recorded.event).toMatchObject({
        type: "shell:before",
        command: "npm test",
        cwd: "/repo/subdir",
        metadata: { sessionId: "sess-camel" },
      });

      // Execute PostToolUse -> shell:after with input.cwd
      res = runRunner(runnerPath, {
        hook_event_name: "PostToolUse",
        cwd: "/repo/subdir",
        tool_name: "Execute",
        tool_input: { command: "npm test" },
        tool_response: { exitCode: 0, stdout: "ok", stderr: "" },
      });
      expect(res.status).toBe(0);
      recorded = JSON.parse(await readFile(outputFile, "utf-8")) as {
        event: Record<string, unknown>;
      };
      expect(recorded.event).toMatchObject({
        type: "shell:after",
        command: "npm test",
        cwd: "/repo/subdir",
        exitCode: 0,
        stdout: "ok",
      });

      // Create -> file:write
      res = runRunner(runnerPath, {
        hook_event_name: "PreToolUse",
        tool_name: "Create",
        tool_input: { file_path: "src/new.ts", content: "export const x = 1;" },
      });
      expect(res.status).toBe(0);
      recorded = JSON.parse(await readFile(outputFile, "utf-8")) as {
        event: Record<string, unknown>;
      };
      expect(recorded.event).toMatchObject({
        type: "file:write",
        path: "src/new.ts",
        content: "export const x = 1;",
      });

      // MultiEdit -> file:edit
      res = runRunner(runnerPath, {
        hook_event_name: "PreToolUse",
        tool_name: "MultiEdit",
        tool_input: { file_path: "src/app.ts", old_string: "a", new_string: "b" },
      });
      expect(res.status).toBe(0);
      recorded = JSON.parse(await readFile(outputFile, "utf-8")) as {
        event: Record<string, unknown>;
      };
      expect(recorded.event).toMatchObject({
        type: "file:edit",
        path: "src/app.ts",
        oldContent: "a",
        newContent: "b",
      });

      // ApplyPatch -> file:edit
      res = runRunner(runnerPath, {
        hook_event_name: "PreToolUse",
        tool_name: "ApplyPatch",
        tool_input: { path: "src/patch.ts", patch: "+export const y = 2;" },
      });
      expect(res.status, res.stderr).toBe(0);
      recorded = JSON.parse(await readFile(outputFile, "utf-8")) as {
        event: Record<string, unknown>;
      };
      expect(recorded.event).toMatchObject({
        type: "file:edit",
        path: "src/patch.ts",
        newContent: "+export const y = 2;",
      });

      // Read -> file:read
      res = runRunner(runnerPath, {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "README.md" },
      });
      expect(res.status, res.stderr).toBe(0);
      recorded = JSON.parse(await readFile(outputFile, "utf-8")) as {
        event: Record<string, unknown>;
      };
      expect(recorded.event).toMatchObject({
        type: "file:read",
        path: "README.md",
      });

      // mcp:* -> mcp:before
      res = runRunner(runnerPath, {
        hook_event_name: "PreToolUse",
        tool_name: "mcp:linear:list_issues",
        tool_input: { team: "ENG" },
      });
      expect(res.status).toBe(0);
      recorded = JSON.parse(await readFile(outputFile, "utf-8")) as {
        event: Record<string, unknown>;
      };
      expect(recorded.event).toMatchObject({
        type: "mcp:before",
        server: "linear",
        method: "list_issues",
        params: { team: "ENG" },
      });
    });

    it("maps Stop to prompt:response and reads top-level prompt & message fields", async () => {
      const { runnerPath, outputFile } = await setupRunnerMock();

      let res = runRunner(runnerPath, {
        hook_event_name: "Stop",
        session_id: "sess-1",
        last_assistant_message: "All done!",
      });
      expect(res.status).toBe(0);
      let recorded = JSON.parse(await readFile(outputFile, "utf-8")) as {
        event: Record<string, unknown>;
      };
      expect(recorded.event).toMatchObject({
        type: "prompt:response",
        response: "All done!",
        metadata: { sessionId: "sess-1" },
      });

      res = runRunner(runnerPath, {
        hook_event_name: "UserPromptSubmit",
        prompt: "Refactor auth",
      });
      expect(res.status).toBe(0);
      recorded = JSON.parse(await readFile(outputFile, "utf-8")) as {
        event: Record<string, unknown>;
      };
      expect(recorded.event).toMatchObject({
        type: "prompt:submit",
        prompt: "Refactor auth",
      });

      res = runRunner(runnerPath, {
        hook_event_name: "Notification",
        message: "Build succeeded",
      });
      expect(res.status).toBe(0);
      recorded = JSON.parse(await readFile(outputFile, "utf-8")) as {
        event: Record<string, unknown>;
      };
      expect(recorded.event).toMatchObject({
        type: "notification",
        message: "Build succeeded",
      });
    });

    it("exits with code 2 and writes block reason to stderr when blocked", async () => {
      const { runnerPath } = await setupRunnerMock("Dangerous command blocked");
      const res = runRunner(runnerPath, {
        hook_event_name: "PreToolUse",
        tool_name: "Execute",
        tool_input: { command: "rm -rf /" },
      });
      expect(res.status).toBe(2);
      expect(res.stderr).toContain("Dangerous command blocked");
    });
  });
});
