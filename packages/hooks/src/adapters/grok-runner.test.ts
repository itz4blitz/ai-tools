import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCompatPayload, readStdinText, runGrokHook } from "./grok-runner.js";
import type { AiHooksConfig, HookDefinition } from "../types/index.js";

const temps: string[] = [];

class NonErrorFailure {
  toString(): string {
    return "non-error";
  }
}

async function* stdinChunks() {
  yield Buffer.from('{"hookEventName":"');
  yield 'SessionStart"}';
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grok-runner-"));
  temps.push(dir);
  return dir;
}

function markerHook(markerPath: string): HookDefinition {
  return {
    id: "write-marker",
    name: "write-marker",
    events: ["shell:before"],
    phase: "before",
    handler: async (ctx, next) => {
      if (ctx.event.type === "shell:before") {
        await writeFile(markerPath, ctx.event.command, "utf-8");
      }
      await next();
    },
  };
}

function blockHook(): HookDefinition {
  return {
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
}

describe("runGrokHook", () => {
  it("runs a configured hook that writes a file when Grok invokes the runner", async () => {
    const dir = await tempDir();
    const marker = join(dir, "ran.txt");
    const config: AiHooksConfig = { hooks: [markerHook(marker)] };

    const code = await runGrokHook({
      config,
      stdin: JSON.stringify({
        hookEventName: "pre_tool_use",
        toolName: "run_terminal_command",
        toolInput: { command: "echo from-grok" },
        cwd: dir,
      }),
    });

    expect(code).toBe(0);
    expect(await readFile(marker, "utf-8")).toBe("echo from-grok");
  });

  it("loads ai-hooks.config.js and runs its hook when no config is passed", async () => {
    const dir = await tempDir();
    const marker = join(dir, "from-config.txt");
    await writeFile(
      join(dir, "ai-hooks.config.js"),
      `import { writeFile } from "node:fs/promises";
export default {
  hooks: [{
    id: "from-file",
    name: "from-file",
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

    const code = await runGrokHook({
      cwd: dir,
      stdin: JSON.stringify({
        hookEventName: "PreToolUse",
        toolName: "Bash",
        tool_input: { command: "echo loaded" },
      }),
    });

    expect(code).toBe(0);
    expect(await readFile(marker, "utf-8")).toBe("echo loaded");
  });

  it("denies a blocking PreToolUse hook with Grok decision JSON and exit 2", async () => {
    const chunks: string[] = [];
    const code = await runGrokHook({
      config: { hooks: [blockHook()] },
      stdin: JSON.stringify({
        hookEventName: "pre_tool_use",
        toolName: "run_terminal_command",
        toolInput: { command: "rm -rf /" },
      }),
      stdout: { write: (chunk: string) => chunks.push(chunk) },
    });

    expect(code).toBe(2);
    expect(JSON.parse(chunks.join(""))).toEqual({
      decision: "deny",
      reason: "Dangerous command",
    });
  });

  it("uses GROK_HOOK_EVENT when stdin omits hookEventName", async () => {
    const dir = await tempDir();
    const marker = join(dir, "env.txt");
    const code = await runGrokHook({
      config: { hooks: [markerHook(marker)] },
      env: { ...process.env, GROK_HOOK_EVENT: "pre_tool_use" },
      stdin: JSON.stringify({
        toolName: "run_terminal_command",
        toolInput: { command: "echo env" },
      }),
    });
    expect(code).toBe(0);
    expect(await readFile(marker, "utf-8")).toBe("echo env");
  });

  it("fails open on errors instead of blocking", async () => {
    const err: string[] = [];
    const code = await runGrokHook({
      cwd: "/tmp/ai-hooks-missing-config-dir",
      stdin: JSON.stringify({ hookEventName: "SessionStart" }),
      stderr: { write: (chunk: string) => err.push(chunk) },
    });
    expect(code).toBe(0);
    expect(err.join("")).toContain("[ai-hooks] Error:");
  });

  it("exits 0 for unrecognized events", async () => {
    const code = await runGrokHook({
      config: { hooks: [] },
      stdin: JSON.stringify({ hookEventName: "NotARealEvent" }),
    });
    expect(code).toBe(0);
  });

  it("reads streamed stdin chunks and treats invalid JSON as empty", async () => {
    expect(await readStdinText(stdinChunks())).toBe('{"hookEventName":"SessionStart"}');
    expect(parseCompatPayload("{nope")).toEqual({});
    expect(parseCompatPayload("")).toEqual({});
  });

  it("reads process.stdin when no stdin override is provided", async () => {
    const original = process.stdin;
    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: (async function* () {
        yield '{"hookEventName":"SessionEnd"}';
      })(),
    });
    try {
      expect(await runGrokHook({ config: { hooks: [] } })).toBe(0);
    } finally {
      Object.defineProperty(process, "stdin", { configurable: true, value: original });
    }
  });

  it("uses the default deny reason and fail-opens on non-Error throws", async () => {
    const chunks: string[] = [];
    const code = await runGrokHook({
      config: {
        hooks: [
          {
            id: "block",
            name: "block",
            events: ["prompt:submit"],
            phase: "before",
            handler: async (ctx, next) => {
              void next;
              ctx.results.push({ blocked: true });
            },
          },
        ],
      },
      stdin: JSON.stringify({ hookEventName: "UserPromptSubmit", prompt: "hi" }),
      stdout: {
        write: () => {
          throw new NonErrorFailure();
        },
      },
      stderr: { write: (chunk: string) => chunks.push(chunk) },
    });
    expect(code).toBe(0);
    expect(chunks.join("")).toContain("non-error");
  });

  it("emits the default deny reason when a blocking hook omits one", async () => {
    const out: string[] = [];
    const code = await runGrokHook({
      config: {
        hooks: [
          {
            id: "block",
            name: "block",
            events: ["prompt:submit"],
            phase: "before",
            handler: async (ctx, next) => {
              void next;
              ctx.results.push({ blocked: true });
            },
          },
        ],
      },
      stdin: JSON.stringify({ hookEventName: "UserPromptSubmit", prompt: "hi" }),
      stdout: { write: (chunk: string) => out.push(chunk) },
    });
    expect(code).toBe(2);
    expect(JSON.parse(out.join(""))).toEqual({
      decision: "deny",
      reason: "Blocked by ai-hooks",
    });
  });

  it("forwards result.data.additionalContext via hookSpecificOutput", async () => {
    const out: string[] = [];
    const code = await runGrokHook({
      config: {
        hooks: [
          {
            id: "ctx-1",
            name: "ctx-1",
            events: ["prompt:submit"],
            phase: "before",
            handler: async (ctx, next) => {
              ctx.results.push({ data: { additionalContext: "Remember to run tests." } });
              await next();
            },
          },
          {
            id: "ctx-2",
            name: "ctx-2",
            events: ["prompt:submit"],
            phase: "before",
            handler: async (ctx, next) => {
              ctx.results.push({ data: { additionalContext: "Use strict TypeScript." } });
              await next();
            },
          },
        ],
      },
      stdin: JSON.stringify({ hookEventName: "UserPromptSubmit", prompt: "refactor auth" }),
      stdout: { write: (chunk: string) => out.push(chunk) },
    });

    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Remember to run tests.\nUse strict TypeScript.",
      },
    });
  });

  it("dispatches Stop events with lastAssistantMessage as prompt:response", async () => {
    const dir = await tempDir();
    const marker = join(dir, "response.txt");
    const code = await runGrokHook({
      config: {
        hooks: [
          {
            id: "log-response",
            name: "log-response",
            events: ["prompt:response"],
            phase: "after",
            handler: async (ctx, next) => {
              if (ctx.event.type === "prompt:response") {
                await writeFile(marker, ctx.event.response, "utf-8");
              }
              await next();
            },
          },
        ],
      },
      stdin: JSON.stringify({
        hookEventName: "Stop",
        lastAssistantMessage: "All checks passed.",
      }),
    });

    expect(code).toBe(0);
    expect(await readFile(marker, "utf-8")).toBe("All checks passed.");
  });
});
