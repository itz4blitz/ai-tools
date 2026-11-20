import { describe, expect, it } from "vitest";
import type { AiHooksConfig, HookEvent } from "../types/index.js";
import { buildAntigravityEvent, runAntigravityCliHook } from "./antigravity-cli-runner.js";

function makeRecorder() {
  const chunks: string[] = [];
  return {
    writer: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    text: () => chunks.join(""),
  };
}

describe("buildAntigravityEvent", () => {
  it("maps Antigravity tool calls to universal events", () => {
    const shellEvt = buildAntigravityEvent("PreToolUse", {
      hookEventName: "PreToolUse",
      cwd: "/repo",
      toolCall: { id: "t1", name: "run_command", args: { CommandLine: "rm -rf /" } },
    });
    expect(shellEvt).toMatchObject({
      type: "shell:before",
      command: "rm -rf /",
      cwd: "/repo",
    });

    const writeEvt = buildAntigravityEvent("PreToolUse", {
      hookEventName: "PreToolUse",
      toolCall: {
        id: "t2",
        name: "write_to_file",
        args: { TargetFile: "/a.ts", CodeContent: "x" },
      },
    });
    expect(writeEvt).toMatchObject({ type: "file:write", path: "/a.ts", content: "x" });

    const writeFileEvt = buildAntigravityEvent("PreToolUse", {
      hookEventName: "PreToolUse",
      toolCall: { id: "t3", name: "write_file", args: { Path: "/b.ts", Content: "y" } },
    });
    expect(writeFileEvt).toMatchObject({ type: "file:write", path: "/b.ts", content: "y" });

    const editEvt = buildAntigravityEvent("PreToolUse", {
      hookEventName: "PreToolUse",
      toolCall: {
        id: "t4",
        name: "edit_file",
        args: { Path: "/c.ts", Target: "old", Replacement: "new" },
      },
    });
    expect(editEvt).toMatchObject({
      type: "file:edit",
      path: "/c.ts",
      oldContent: "old",
      newContent: "new",
    });

    const readEvt = buildAntigravityEvent("PreToolUse", {
      hookEventName: "PreToolUse",
      toolCall: { id: "t5", name: "view_file", args: { AbsolutePath: "/d.ts" } },
    });
    expect(readEvt).toMatchObject({ type: "file:read", path: "/d.ts" });

    const readFileEvt = buildAntigravityEvent("PreToolUse", {
      hookEventName: "PreToolUse",
      toolCall: { id: "t6", name: "read_file", args: { Path: "/e.ts" } },
    });
    expect(readFileEvt).toMatchObject({ type: "file:read", path: "/e.ts" });

    const mcpEvt = buildAntigravityEvent("PreToolUse", {
      hookEventName: "PreToolUse",
      toolCall: { id: "t7", name: "mcp_linear_get_issue", args: { id: "ENG-1" } },
    });
    expect(mcpEvt).toMatchObject({
      type: "mcp:before",
      server: "linear",
      method: "get_issue",
      params: { id: "ENG-1" },
    });
  });

  it("maps lifecycle events and preserves error/terminationReason metadata", () => {
    const preInv = buildAntigravityEvent("PreInvocation", {
      hookEventName: "PreInvocation",
      lastUserInput: "deploy now",
    });
    expect(preInv).toMatchObject({ type: "prompt:submit", prompt: "deploy now" });

    const stopEvt = buildAntigravityEvent("Stop", {
      hookEventName: "Stop",
      terminationReason: "completed",
      error: "none",
    });
    expect(stopEvt).toMatchObject({
      type: "session:end",
      tool: "antigravity-cli",
      metadata: { terminationReason: "completed", error: "none" },
    });
  });
});

describe("runAntigravityCliHook", () => {
  it("emits { decision: 'allow' } for allowed PreToolUse and { decision: 'deny', reason } when blocked", async () => {
    const seen: HookEvent[] = [];
    const config: AiHooksConfig = {
      hooks: [
        {
          id: "block-rm",
          name: "block-rm",
          events: ["shell:before"],
          phase: "before",
          handler: async (ctx, next) => {
            seen.push(ctx.event);
            if (ctx.event.type === "shell:before" && ctx.event.command.includes("rm -rf")) {
              ctx.results.push({ blocked: true, reason: "Dangerous command blocked" });
              return;
            }
            await next();
          },
        },
      ],
    };

    const allowOut = makeRecorder();
    const allowCode = await runAntigravityCliHook({
      stdin: JSON.stringify({
        hookEventName: "PreToolUse",
        cwd: "/repo",
        toolCall: { id: "1", name: "run_command", args: { CommandLine: "git status" } },
      }),
      config,
      stdout: allowOut.writer,
    });
    expect(allowCode).toBe(0);
    expect(JSON.parse(allowOut.text())).toEqual({ decision: "allow" });

    const denyOut = makeRecorder();
    const denyCode = await runAntigravityCliHook({
      stdin: JSON.stringify({
        hookEventName: "PreToolUse",
        cwd: "/repo",
        toolCall: { id: "2", name: "run_command", args: { CommandLine: "rm -rf /" } },
      }),
      config,
      stdout: denyOut.writer,
    });
    expect(denyCode).toBe(0);
    expect(JSON.parse(denyOut.text())).toEqual({
      decision: "deny",
      reason: "Dangerous command blocked",
    });
    expect(seen).toHaveLength(2);
  });

  it("emits {} for PostToolUse", async () => {
    const out = makeRecorder();
    const code = await runAntigravityCliHook({
      stdin: JSON.stringify({
        hookEventName: "PostToolUse",
        cwd: "/repo",
        toolCall: { id: "1", name: "run_command", args: { CommandLine: "ls" } },
        toolResult: { exitCode: 0, stdout: "ok" },
      }),
      config: { hooks: [] },
      stdout: out.writer,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toEqual({});
  });

  it("emits terminationBehavior and injectSteps for blocked PreInvocation", async () => {
    const out = makeRecorder();
    const code = await runAntigravityCliHook({
      stdin: JSON.stringify({
        hookEventName: "PreInvocation",
        lastUserInput: "secret prompt",
      }),
      config: {
        hooks: [
          {
            id: "guard-prompt",
            name: "guard-prompt",
            events: ["prompt:submit"],
            phase: "before",
            handler: async (ctx) => {
              ctx.results.push({ blocked: true, reason: "Prompt rejected" });
            },
          },
        ],
      },
      stdout: out.writer,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toEqual({
      terminationBehavior: "terminate",
      injectSteps: [{ type: "USER_MESSAGE", content: "Prompt rejected" }],
    });
  });

  it("emits { decision: 'continue', reason } for blocked Stop", async () => {
    const out = makeRecorder();
    const code = await runAntigravityCliHook({
      stdin: JSON.stringify({
        hookEventName: "Stop",
        terminationReason: "done",
      }),
      config: {
        hooks: [
          {
            id: "keep-going",
            name: "keep-going",
            events: ["session:end"],
            phase: "after",
            handler: async (ctx) => {
              ctx.results.push({ blocked: true, reason: "Run tests before stopping" });
            },
          },
        ],
      },
      stdout: out.writer,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toEqual({
      decision: "continue",
      reason: "Run tests before stopping",
    });
  });
});
