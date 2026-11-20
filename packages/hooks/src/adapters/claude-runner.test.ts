import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runClaudeCodeHook } from "./claude-runner.js";
import type { AiHooksConfig, HookDefinition } from "../types/index.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-runner-"));
  temps.push(dir);
  return dir;
}

describe("runClaudeCodeHook", () => {
  it("parses stdin JSON for PreToolUse Bash and denies with hookSpecificOutput", async () => {
    const out: string[] = [];
    const blockHook: HookDefinition = {
      id: "block-rm",
      name: "block-rm",
      events: ["shell:before"],
      phase: "before",
      handler: async (ctx, next) => {
        if (ctx.event.type === "shell:before" && ctx.event.command.includes("rm -rf /")) {
          ctx.results.push({ blocked: true, reason: "Dangerous command" });
          return;
        }
        await next();
      },
    };

    const code = await runClaudeCodeHook({
      config: { hooks: [blockHook] },
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
        cwd: "/repo",
        session_id: "sess-123",
      }),
      stdout: { write: (chunk: string) => out.push(chunk) },
    });

    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Dangerous command",
      },
    });
  });

  it("handles Read, MultiEdit, and mcp__* tools on PreToolUse and propagates session_id", async () => {
    const seen: Array<{ type: string; detail: string; sessionId?: unknown }> = [];
    const readObserver: HookDefinition = {
      id: "obs-read",
      name: "obs-read",
      events: ["file:read"],
      phase: "after",
      handler: async (ctx, next) => {
        if (ctx.event.type === "file:read") {
          seen.push({
            type: ctx.event.type,
            detail: ctx.event.path,
            sessionId: ctx.event.metadata.sessionId,
          });
        }
        await next();
      },
    };
    const beforeObserver: HookDefinition = {
      id: "obs-before",
      name: "obs-before",
      events: ["file:edit", "mcp:before"],
      phase: "before",
      handler: async (ctx, next) => {
        if (ctx.event.type === "file:edit") {
          seen.push({
            type: ctx.event.type,
            detail: ctx.event.path,
            sessionId: ctx.event.metadata.sessionId,
          });
        } else if (ctx.event.type === "mcp:before") {
          seen.push({
            type: ctx.event.type,
            detail: `${ctx.event.server}:${ctx.event.method}`,
            sessionId: ctx.event.metadata.sessionId,
          });
        }
        await next();
      },
    };
    const config: AiHooksConfig = { hooks: [readObserver, beforeObserver] };

    await runClaudeCodeHook({
      config,
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "src/app.ts" },
        session_id: "s1",
      }),
    });
    await runClaudeCodeHook({
      config,
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "MultiEdit",
        tool_input: { file_path: "src/index.ts", old_string: "a", new_string: "b" },
        session_id: "s2",
      }),
    });
    await runClaudeCodeHook({
      config,
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "mcp__linear__list_issues",
        tool_input: { team: "ENG" },
        session_id: "s3",
      }),
    });

    expect(seen).toEqual([
      { type: "file:read", detail: "src/app.ts", sessionId: "s1" },
      { type: "file:edit", detail: "src/index.ts", sessionId: "s2" },
      { type: "mcp:before", detail: "mcp:linear", sessionId: "s3" },
    ]);
  });

  it("emits { decision: 'block', reason } for blocked Stop and UserPromptSubmit", async () => {
    const stopOut: string[] = [];
    const promptOut: string[] = [];

    const stopCode = await runClaudeCodeHook({
      config: {
        hooks: [
          {
            id: "block-stop",
            name: "block-stop",
            events: ["prompt:response"],
            phase: "after",
            handler: async (ctx, next) => {
              void next;
              ctx.results.push({ blocked: true, reason: "Run tests first" });
            },
          },
        ],
      },
      stdin: JSON.stringify({
        hook_event_name: "Stop",
        last_assistant_message: "All done!",
      }),
      stdout: { write: (chunk: string) => stopOut.push(chunk) },
    });

    const promptCode = await runClaudeCodeHook({
      config: {
        hooks: [
          {
            id: "block-prompt",
            name: "block-prompt",
            events: ["prompt:submit"],
            phase: "before",
            handler: async (ctx, next) => {
              void next;
              ctx.results.push({ blocked: true, reason: "Secret detected in prompt" });
            },
          },
        ],
      },
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "my secret key",
      }),
      stdout: { write: (chunk: string) => promptOut.push(chunk) },
    });

    expect(stopCode).toBe(0);
    expect(JSON.parse(stopOut.join(""))).toEqual({
      decision: "block",
      reason: "Run tests first",
    });

    expect(promptCode).toBe(0);
    expect(JSON.parse(promptOut.join(""))).toEqual({
      decision: "block",
      reason: "Secret detected in prompt",
    });
  });

  it("emits additionalContext when provided by a hook", async () => {
    const out: string[] = [];
    const code = await runClaudeCodeHook({
      config: {
        hooks: [
          {
            id: "ctx-hook",
            name: "ctx-hook",
            events: ["prompt:submit"],
            phase: "before",
            handler: async (ctx, next) => {
              ctx.results.push({
                blocked: false,
                data: { additionalContext: "Remember to run vitest." },
              });
              await next();
            },
          },
        ],
      },
      stdin: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "implement feature",
      }),
      stdout: { write: (chunk: string) => out.push(chunk) },
    });

    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Remember to run vitest.",
      },
    });
  });

  it("handles SessionEnd, Notification, and PostToolUse tool_response", async () => {
    const seen: string[] = [];
    const config: AiHooksConfig = {
      hooks: [
        {
          id: "lifecycle",
          name: "lifecycle",
          events: ["session:end", "notification", "shell:after"],
          phase: "after",
          handler: async (ctx, next) => {
            if (ctx.event.type === "session:end") seen.push(`end:${ctx.event.tool}`);
            if (ctx.event.type === "notification") seen.push(`notify:${ctx.event.message}`);
            if (ctx.event.type === "shell:after") {
              seen.push(`shell:${ctx.event.command}:${ctx.event.stdout}`);
            }
            await next();
          },
        },
      ],
    };

    await runClaudeCodeHook({
      config,
      stdin: JSON.stringify({ hook_event_name: "SessionEnd", cwd: "/repo" }),
    });
    await runClaudeCodeHook({
      config,
      stdin: JSON.stringify({
        hook_event_name: "Notification",
        message: "Build succeeded",
        notification_type: "idle_prompt",
      }),
    });
    await runClaudeCodeHook({
      config,
      stdin: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo ok" },
        tool_response: { stdout: "ok", exitCode: 0 },
      }),
    });

    expect(seen).toEqual(["end:claude-code", "notify:Build succeeded", "shell:echo ok:ok"]);
  });

  it("loads ai-hooks.config.js from cwd when config is omitted", async () => {
    const dir = await tempDir();
    const marker = join(dir, "ran.txt");
    await writeFile(
      join(dir, "ai-hooks.config.js"),
      `import { writeFile } from "node:fs/promises";
export default {
  hooks: [{
    id: "write-marker",
    name: "write-marker",
    events: ["shell:before"],
    phase: "before",
    handler: async (ctx, next) => {
      if (ctx.event.type === "shell:before") {
        await writeFile(${JSON.stringify(marker)}, ctx.event.command, "utf8");
      }
      await next();
    },
  }],
};
`,
      "utf-8",
    );

    const code = await runClaudeCodeHook({
      cwd: dir,
      stdin: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        cwd: dir,
      }),
    });

    expect(code).toBe(0);
    expect(await readFile(marker, "utf-8")).toBe("npm test");
  });

  it("fails open on errors and writes to stderr", async () => {
    const err: string[] = [];
    const code = await runClaudeCodeHook({
      cwd: join(tmpdir(), "nonexistent-claude-hooks-dir-xyz"),
      stdin: JSON.stringify({ hook_event_name: "SessionStart" }),
      stderr: { write: (chunk: string) => err.push(chunk) },
    });

    expect(code).toBe(0);
    expect(err.join("")).toContain("[ai-hooks] Error:");
  });
});
