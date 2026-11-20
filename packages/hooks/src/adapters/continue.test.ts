import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AiHooksConfig, HookContext, HookDefinition, HookEventType } from "../index.js";

vi.mock("./index.js", async () => {
  const { BaseAdapter } = await import("./base.js");
  return { BaseAdapter, registry: { register: vi.fn() } };
});

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (error: Error | null) => void) => {
    cb(new Error("not found"));
  }),
}));

import { execFile } from "node:child_process";
import { ContinueAdapter, runContinueHook } from "./continue.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

const shellHook: HookDefinition = {
  id: "guard",
  name: "guard",
  events: ["shell:before" as HookEventType, "prompt:submit" as HookEventType],
  phase: "before",
  handler: makeHandler(),
};

describe("ContinueAdapter (hooks)", () => {
  let adapter: ContinueAdapter;
  let tmp: string;
  let previousCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "continue-hooks-"));
    adapter = new ContinueAdapter();
    previousCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  it("exposes Continue identity and Claude Code-compatible event mappings", () => {
    expect(adapter.id).toBe("continue");
    expect(adapter.name).toBe("Continue");
    expect(adapter.mapEvent("shell:before")).toEqual(["PreToolUse"]);
    expect(adapter.mapEvent("shell:after")).toEqual(["PostToolUse"]);
    expect(adapter.mapEvent("session:start")).toEqual(["SessionStart"]);
    expect(adapter.mapEvent("session:end")).toEqual(["SessionEnd"]);
    expect(adapter.mapEvent("prompt:submit")).toEqual(["UserPromptSubmit"]);
    expect(adapter.mapEvent("prompt:response")).toEqual(["Stop"]);
    expect(adapter.mapEvent("notification")).toEqual(["Notification"]);
    expect(adapter.mapEvent("unknown" as HookEventType)).toEqual([]);
    expect(adapter.mapNativeEvent("PreToolUse")).toContain("shell:before");
    expect(adapter.mapNativeEvent("UserPromptSubmit")).toEqual(["prompt:submit"]);
    expect(adapter.mapNativeEvent("UnknownEvent")).toEqual([]);
  });

  it("generates .continue/settings.json and runner with JSON.stringify PROJECT_ROOT", async () => {
    const configs = await adapter.generate([shellHook]);
    await adapter.install(configs);

    expect(configs.map((c) => c.path)).toEqual([
      ".continue/hooks/ai-tools-hooks-runner.js",
      ".continue/settings.json",
    ]);

    const runner = await readFile(join(tmp, ".continue/hooks/ai-tools-hooks-runner.js"), "utf-8");
    expect(runner.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(runner).toContain(`const PROJECT_ROOT = ${JSON.stringify(resolve(process.cwd()))};`);

    const settings = JSON.parse(await readFile(join(tmp, ".continue/settings.json"), "utf-8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe("*");
    expect(settings.hooks.PreToolUse?.[0]?.hooks[0]?.command).toContain("ai-tools-hooks-runner.js");
    expect(settings.hooks.UserPromptSubmit?.[0]?.matcher).toBeUndefined();
  });

  it("non-destructively merges into existing .continue/settings.json and avoids duplicates", async () => {
    await mkdir(join(tmp, ".continue"), { recursive: true });
    await writeFile(
      join(tmp, ".continue/settings.json"),
      JSON.stringify({
        theme: "dark",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo user-stop" }] }],
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo custom-pre" }] },
          ],
        },
      }),
      "utf-8",
    );

    await adapter.install(await adapter.generate([shellHook]));
    // Re-running should not duplicate ai-tools runner entries
    await adapter.install(await adapter.generate([shellHook]));

    const settings = JSON.parse(await readFile(join(tmp, ".continue/settings.json"), "utf-8")) as {
      theme: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it("imports hooks from .continue/settings.json", async () => {
    await adapter.install(await adapter.generate([shellHook]));
    const imported = await adapter.import(tmp);
    expect(imported).toHaveLength(2);
    expect(imported.some((h) => h.events.includes("shell:before"))).toBe(true);
    expect(imported.some((h) => h.events.includes("prompt:submit"))).toBe(true);
  });

  it("detects .continue directory or cn binary", async () => {
    expect(await adapter.detect()).toBe(false);

    await mkdir(join(tmp, ".continue"), { recursive: true });
    expect(await adapter.detect()).toBe(true);
    await rm(join(tmp, ".continue"), { recursive: true, force: true });

    vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof execFile);
    expect(await adapter.detect()).toBe(true);
  });

  it("non-destructively uninstalls runner and strips only ai-tools hooks from settings.json", async () => {
    await mkdir(join(tmp, ".continue"), { recursive: true });
    await writeFile(
      join(tmp, ".continue/settings.json"),
      JSON.stringify({
        model: "keep-me",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo keep-stop" }] }],
        },
      }),
      "utf-8",
    );

    await adapter.install(await adapter.generate([shellHook]));
    await adapter.uninstall();

    expect(existsSync(join(tmp, ".continue/hooks/ai-tools-hooks-runner.js"))).toBe(false);
    const settings = JSON.parse(await readFile(join(tmp, ".continue/settings.json"), "utf-8")) as {
      model: string;
      hooks?: Record<string, unknown[]>;
    };
    expect(settings.model).toBe("keep-me");
    expect(settings.hooks?.Stop).toHaveLength(1);
    expect(settings.hooks?.PreToolUse).toBeUndefined();
    expect(settings.hooks?.UserPromptSubmit).toBeUndefined();
  });

  it("does not create settings.json on uninstall when missing", async () => {
    await adapter.uninstall();
    expect(existsSync(join(tmp, ".continue/settings.json"))).toBe(false);
  });

  describe("runContinueHook", () => {
    it("blocks PreToolUse with exit code 2 and reason on stderr via claude-compat", async () => {
      let stderrText = "";
      const config: AiHooksConfig = {
        hooks: [
          {
            id: "block-rm",
            name: "block-rm",
            events: ["shell:before"],
            phase: "before",
            handler: async (ctx, next) => {
              void next;
              ctx.results.push({ blocked: true, reason: "Dangerous command blocked" });
            },
          },
        ],
      };

      const code = await runContinueHook({
        stdin: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "rm -rf /" },
        }),
        config,
        stderr: {
          write(chunk: string) {
            stderrText += chunk;
          },
        },
      });

      expect(code).toBe(2);
      expect(stderrText).toBe("Dangerous command blocked");
    });

    it("returns 0 for non-blocking or unknown events", async () => {
      const code = await runContinueHook({
        stdin: JSON.stringify({ hook_event_name: "UnknownEvent" }),
        config: { hooks: [] },
      });
      expect(code).toBe(0);
    });
  });
});
