import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AiHooksConfig, HookContext, HookDefinition, HookEventType } from "../types/index.js";

const { mockHome } = vi.hoisted(() => ({ mockHome: { value: "" } }));

vi.mock("./index.js", async () => {
  const { BaseAdapter } = await import("./base.js");
  return { BaseAdapter, registry: { register: vi.fn() } };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHome.value || actual.homedir(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (error: Error | null) => void) => {
    cb(new Error("not found"));
  }),
}));

import { execFile } from "node:child_process";
import { WindsurfAdapter } from "./windsurf.js";
import { runWindsurfHook } from "./windsurf-runner.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

const shellHook: HookDefinition = {
  id: "guard-shell",
  name: "guard-shell",
  events: ["shell:before", "shell:after"],
  phase: "before",
  handler: makeHandler(),
};

describe("WindsurfAdapter", () => {
  let adapter: WindsurfAdapter;
  let tmp: string;
  let home: string;
  let previousCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "windsurf-hooks-"));
    home = await mkdtemp(join(tmpdir(), "windsurf-hooks-home-"));
    mockHome.value = home;
    adapter = new WindsurfAdapter();
    previousCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("maps universal events to Windsurf Cascade hook events and back", () => {
    expect(adapter.id).toBe("windsurf");
    expect(adapter.name).toBe("Windsurf");
    expect(adapter.mapEvent("prompt:submit")).toEqual(["pre_user_prompt"]);
    expect(adapter.mapEvent("file:read")).toEqual(["pre_read_code"]);
    expect(adapter.mapEvent("file:write")).toEqual(["pre_write_code", "post_write_code"]);
    expect(adapter.mapEvent("file:edit")).toEqual(["pre_write_code", "post_write_code"]);
    expect(adapter.mapEvent("shell:before")).toEqual(["pre_run_command"]);
    expect(adapter.mapEvent("shell:after")).toEqual(["post_run_command"]);
    expect(adapter.mapEvent("mcp:before")).toEqual(["pre_mcp_tool_use"]);
    expect(adapter.mapEvent("tool:before")).toEqual(["pre_mcp_tool_use"]);
    expect(adapter.mapEvent("mcp:after")).toEqual(["post_mcp_tool_use"]);
    expect(adapter.mapEvent("tool:after")).toEqual(["post_mcp_tool_use"]);
    expect(adapter.mapEvent("notification")).toEqual([]);
    expect(adapter.mapEvent("unknown" as HookEventType)).toEqual([]);

    expect(adapter.mapNativeEvent("pre_user_prompt")).toEqual(["prompt:submit"]);
    expect(adapter.mapNativeEvent("pre_read_code")).toEqual(["file:read"]);
    expect(adapter.mapNativeEvent("pre_write_code")).toEqual(["file:write", "file:edit"]);
    expect(adapter.mapNativeEvent("post_write_code")).toEqual(["file:write", "file:edit"]);
    expect(adapter.mapNativeEvent("pre_run_command")).toEqual(["shell:before"]);
    expect(adapter.mapNativeEvent("post_run_command")).toEqual(["shell:after"]);
    expect(adapter.mapNativeEvent("pre_mcp_tool_use")).toEqual(["mcp:before", "tool:before"]);
    expect(adapter.mapNativeEvent("post_mcp_tool_use")).toEqual(["mcp:after", "tool:after"]);
    expect(adapter.mapNativeEvent("unknown")).toEqual([]);
  });

  it("generates .windsurf/hooks.json and runner script with JSON.stringify PROJECT_ROOT", async () => {
    const files = await adapter.generate([shellHook]);
    await adapter.install(files);

    expect(files.map((f) => f.path)).toEqual([
      ".windsurf/hooks.json",
      ".windsurf/hooks/ai-tools-runner.js",
    ]);

    const hooksJson = JSON.parse(await readFile(join(tmp, ".windsurf/hooks.json"), "utf-8")) as {
      hooks: Record<string, Array<{ command: string; show_output?: boolean }>>;
    };
    expect(hooksJson.hooks.pre_run_command).toHaveLength(1);
    expect(hooksJson.hooks.pre_run_command?.[0]?.show_output).toBe(true);
    expect(hooksJson.hooks.pre_run_command?.[0]?.command).toContain("ai-tools-runner.js");
    expect(hooksJson.hooks.pre_run_command?.[0]?.command).toContain("pre_run_command");
    expect(hooksJson.hooks.post_run_command?.[0]?.show_output).toBe(true);

    const runner = await readFile(join(tmp, ".windsurf/hooks/ai-tools-runner.js"), "utf-8");
    expect(runner.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(runner).toContain('import { runWindsurfHook } from "@itz4blitz/ai-tools-hooks"');
    expect(runner).toContain(`const PROJECT_ROOT = ${JSON.stringify(resolve(process.cwd()))};`);
    expect(runner).toContain("process.exit(await runWindsurfHook());");
  });

  it("merges non-destructively into existing .windsurf/hooks.json and preserves user hooks on uninstall", async () => {
    await mkdir(join(tmp, ".windsurf"), { recursive: true });
    await writeFile(
      join(tmp, ".windsurf/hooks.json"),
      `${JSON.stringify({
        hooks: {
          pre_run_command: [{ command: "echo user-hook", show_output: false }],
          pre_user_prompt: [{ command: "echo prompt-hook", show_output: true }],
        },
      })}\n`,
      "utf-8",
    );

    await adapter.install(await adapter.generate([shellHook]));
    const afterInstall = JSON.parse(await readFile(join(tmp, ".windsurf/hooks.json"), "utf-8")) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(afterInstall.hooks.pre_run_command).toHaveLength(2);
    expect(afterInstall.hooks.pre_user_prompt).toHaveLength(1);

    await adapter.uninstall();
    expect(existsSync(join(tmp, ".windsurf/hooks/ai-tools-runner.js"))).toBe(false);
    expect(existsSync(join(tmp, ".windsurf/hooks.json"))).toBe(true);

    const afterUninstall = JSON.parse(
      await readFile(join(tmp, ".windsurf/hooks.json"), "utf-8"),
    ) as { hooks: Record<string, Array<{ command: string }>> };
    expect(afterUninstall.hooks.pre_run_command).toEqual([
      { command: "echo user-hook", show_output: false },
    ]);
    expect(afterUninstall.hooks.pre_user_prompt).toEqual([
      { command: "echo prompt-hook", show_output: true },
    ]);
    expect(afterUninstall.hooks.post_run_command).toBeUndefined();
  });

  it("removes .windsurf/hooks.json completely on uninstall when no user hooks remain", async () => {
    await adapter.install(await adapter.generate([shellHook]));
    await adapter.uninstall();
    expect(existsSync(join(tmp, ".windsurf/hooks.json"))).toBe(false);
    expect(existsSync(join(tmp, ".windsurf/hooks/ai-tools-runner.js"))).toBe(false);
  });

  it("imports hooks from .windsurf/hooks.json", async () => {
    await mkdir(join(tmp, ".windsurf"), { recursive: true });
    await writeFile(
      join(tmp, ".windsurf/hooks.json"),
      JSON.stringify({
        hooks: {
          pre_run_command: [{ command: "python3 guard.py", show_output: true }],
          post_write_code: [{ command: "npx prettier --write", show_output: true }],
        },
      }),
      "utf-8",
    );

    const imported = await adapter.import(tmp);
    expect(imported).toHaveLength(2);
    expect(imported.find((h) => h.name === "python3 guard.py")).toMatchObject({
      events: ["shell:before"],
      phase: "before",
    });
    expect(imported.find((h) => h.name === "npx prettier --write")).toMatchObject({
      events: ["file:write", "file:edit"],
      phase: "after",
    });
  });

  it("detects .windsurf dir, ~/.codeium/windsurf, or windsurf binary", async () => {
    expect(await adapter.detect()).toBe(false);

    await mkdir(join(tmp, ".windsurf"));
    expect(await adapter.detect()).toBe(true);
    await rm(join(tmp, ".windsurf"), { recursive: true, force: true });

    await mkdir(join(home, ".codeium", "windsurf"), { recursive: true });
    expect(await adapter.detect()).toBe(true);
    await rm(join(home, ".codeium"), { recursive: true, force: true });

    vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof execFile);
    expect(await adapter.detect()).toBe(true);
  });
});

describe("runWindsurfHook", () => {
  it("blocks pre_run_command with exit code 2 and writes reason to stderr", async () => {
    const err: string[] = [];
    const config: AiHooksConfig = {
      hooks: [
        {
          id: "block-rm",
          name: "block-rm",
          events: ["shell:before"],
          phase: "before",
          handler: async (ctx, next) => {
            void next;
            if (ctx.event.type === "shell:before" && ctx.event.command.includes("rm -rf")) {
              ctx.results.push({ blocked: true, reason: "Dangerous command blocked" });
            }
          },
        },
      ],
    };

    const code = await runWindsurfHook({
      config,
      stdin: JSON.stringify({
        agent_action_name: "pre_run_command",
        tool_info: { command_line: "rm -rf /tmp/demo", cwd: "/repo" },
      }),
      stderr: { write: (chunk: string) => err.push(chunk) },
    });

    expect(code).toBe(2);
    expect(err.join("")).toBe("Dangerous command blocked");
  });

  it("dispatches pre_user_prompt, pre_read_code, pre_write_code, pre_mcp_tool_use, and post_* events", async () => {
    const seen: string[] = [];
    const config: AiHooksConfig = {
      hooks: [
        {
          id: "spy-before",
          name: "spy-before",
          events: ["prompt:submit", "file:write", "file:edit", "mcp:before"],
          phase: "before",
          handler: async (ctx, next) => {
            seen.push(ctx.event.type);
            await next();
          },
        },
        {
          id: "spy-after",
          name: "spy-after",
          events: ["file:read", "shell:after", "mcp:after"],
          phase: "after",
          handler: async (ctx, next) => {
            seen.push(ctx.event.type);
            await next();
          },
        },
      ],
    };

    expect(
      await runWindsurfHook({
        config,
        stdin: JSON.stringify({
          agent_action_name: "pre_user_prompt",
          tool_info: { user_prompt: "hello" },
        }),
      }),
    ).toBe(0);

    expect(
      await runWindsurfHook({
        config,
        stdin: JSON.stringify({
          agent_action_name: "pre_read_code",
          tool_info: { file_path: "src/index.ts" },
        }),
      }),
    ).toBe(0);

    expect(
      await runWindsurfHook({
        config,
        stdin: JSON.stringify({
          agent_action_name: "pre_write_code",
          tool_info: { file_path: "src/new.ts", content: "export const a = 1;" },
        }),
      }),
    ).toBe(0);

    expect(
      await runWindsurfHook({
        config,
        stdin: JSON.stringify({
          agent_action_name: "post_write_code",
          tool_info: {
            file_path: "src/index.ts",
            edits: [{ old_string: "a", new_string: "b" }],
          },
        }),
      }),
    ).toBe(0);

    expect(
      await runWindsurfHook({
        config,
        stdin: JSON.stringify({
          agent_action_name: "post_run_command",
          tool_info: { command_line: "npm test", exit_code: 0 },
        }),
      }),
    ).toBe(0);

    expect(
      await runWindsurfHook({
        config,
        argv: ["node", "runner.js", "pre_mcp_tool_use"],
        stdin: JSON.stringify({
          tool_info: { mcp_server_name: "github", mcp_tool_name: "list_prs" },
        }),
      }),
    ).toBe(0);

    expect(
      await runWindsurfHook({
        config,
        stdin: JSON.stringify({
          agent_action_name: "post_mcp_tool_use",
          tool_info: { mcp_server_name: "github", mcp_tool_name: "list_prs", mcp_result: [] },
        }),
      }),
    ).toBe(0);

    expect(seen).toEqual([
      "prompt:submit",
      "file:read",
      "file:write",
      "file:edit",
      "shell:after",
      "mcp:before",
      "mcp:after",
    ]);
  });

  it("does not block post_* events and fails open on errors", async () => {
    const err: string[] = [];
    const postCode = await runWindsurfHook({
      config: {
        hooks: [
          {
            id: "try-block",
            name: "try-block",
            events: ["shell:after"],
            phase: "after",
            handler: async (ctx, next) => {
              void next;
              ctx.results.push({ blocked: true, reason: "ignored" });
            },
          },
        ],
      },
      stdin: JSON.stringify({
        agent_action_name: "post_run_command",
        tool_info: { command_line: "echo hi" },
      }),
      stderr: { write: (chunk: string) => err.push(chunk) },
    });
    expect(postCode).toBe(0);

    const missingConfigCode = await runWindsurfHook({
      cwd: join(tmpdir(), "missing-windsurf-hooks-config"),
      stdin: JSON.stringify({ agent_action_name: "pre_run_command" }),
      stderr: { write: (chunk: string) => err.push(chunk) },
    });
    expect(missingConfigCode).toBe(0);
    expect(err.join("")).toContain("[ai-hooks] Error:");
  });
});
