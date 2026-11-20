import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { CursorAdapter } from "./cursor.js";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
  prefix = "ai-tools-hooks-cursor-",
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
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

describe("CursorAdapter", () => {
  let adapter: CursorAdapter;

  const testHook: HookDefinition = {
    id: "test",
    name: "Test Hook",
    events: ["shell:before"],
    phase: "before",
    handler: makeHandler(),
  };

  beforeEach(() => {
    adapter = new CursorAdapter();
  });

  // ── Metadata / Capabilities ────────────────────────────────

  describe("metadata", () => {
    it("has correct id, name, and version", () => {
      expect(adapter.id).toBe("cursor");
      expect(adapter.name).toBe("Cursor");
      expect(adapter.version).toBe("1.0");
    });
  });

  describe("capabilities", () => {
    it("supports before hooks, after hooks, MCP, and config files", () => {
      expect(adapter.capabilities.beforeHooks).toBe(true);
      expect(adapter.capabilities.afterHooks).toBe(true);
      expect(adapter.capabilities.mcp).toBe(true);
      expect(adapter.capabilities.configFile).toBe(true);
    });

    it("lists all supported events including current Cursor hooks", () => {
      const expected: HookEventType[] = [
        "session:start",
        "session:end",
        "prompt:submit",
        "prompt:response",
        "tool:before",
        "tool:after",
        "file:read",
        "file:write",
        "file:edit",
        "shell:before",
        "shell:after",
        "mcp:before",
        "mcp:after",
      ];
      expect(adapter.capabilities.supportedEvents).toEqual(expected);
    });

    it("lists all blockable events and they are a subset of supportedEvents", () => {
      const expected: HookEventType[] = [
        "prompt:submit",
        "tool:before",
        "file:read",
        "shell:before",
        "mcp:before",
      ];
      expect(adapter.capabilities.blockableEvents).toEqual(expected);
      for (const event of adapter.capabilities.blockableEvents) {
        expect(adapter.capabilities.supportedEvents).toContain(event);
      }
    });
  });

  // ── mapEvent & mapNativeEvent ──────────────────────────────

  describe("mapEvent", () => {
    it("maps all universal events to current Cursor native hooks", () => {
      expect(adapter.mapEvent("session:start")).toEqual(["sessionStart"]);
      expect(adapter.mapEvent("session:end")).toEqual(["sessionEnd"]);
      expect(adapter.mapEvent("prompt:submit")).toEqual(["beforeSubmitPrompt"]);
      expect(adapter.mapEvent("prompt:response")).toEqual(["afterAgentResponse"]);
      expect(adapter.mapEvent("tool:before")).toEqual(["preToolUse"]);
      expect(adapter.mapEvent("tool:after")).toEqual(["postToolUse"]);
      expect(adapter.mapEvent("file:read")).toEqual(["beforeReadFile"]);
      expect(adapter.mapEvent("file:write")).toEqual(["afterFileEdit"]);
      expect(adapter.mapEvent("file:edit")).toEqual(["afterFileEdit"]);
      expect(adapter.mapEvent("file:delete")).toEqual([]);
      expect(adapter.mapEvent("shell:before")).toEqual(["beforeShellExecution"]);
      expect(adapter.mapEvent("shell:after")).toEqual(["afterShellExecution"]);
      expect(adapter.mapEvent("mcp:before")).toEqual(["beforeMCPExecution"]);
      expect(adapter.mapEvent("mcp:after")).toEqual(["afterMCPExecution"]);
      expect(adapter.mapEvent("unknown:event" as HookEventType)).toEqual([]);
    });
  });

  describe("mapNativeEvent", () => {
    it("maps all Cursor native hooks back to universal events", () => {
      expect(adapter.mapNativeEvent("sessionStart")).toEqual(["session:start"]);
      expect(adapter.mapNativeEvent("sessionEnd")).toEqual(["session:end"]);
      expect(adapter.mapNativeEvent("stop")).toEqual(["session:end"]);
      expect(adapter.mapNativeEvent("beforeSubmitPrompt")).toEqual(["prompt:submit"]);
      expect(adapter.mapNativeEvent("afterAgentResponse")).toEqual(["prompt:response"]);
      expect(adapter.mapNativeEvent("preToolUse")).toEqual(["tool:before"]);
      expect(adapter.mapNativeEvent("postToolUse")).toEqual(["tool:after"]);
      expect(adapter.mapNativeEvent("beforeReadFile")).toEqual(["file:read"]);
      expect(adapter.mapNativeEvent("afterFileEdit")).toEqual(["file:write", "file:edit"]);
      expect(adapter.mapNativeEvent("beforeShellExecution")).toEqual(["shell:before"]);
      expect(adapter.mapNativeEvent("afterShellExecution")).toEqual(["shell:after"]);
      expect(adapter.mapNativeEvent("beforeMCPExecution")).toEqual(["mcp:before"]);
      expect(adapter.mapNativeEvent("afterMCPExecution")).toEqual(["mcp:after"]);
      expect(adapter.mapNativeEvent("UnknownNativeEvent")).toEqual([]);
    });
  });

  // ── generate, install, uninstall (real temp dir) ───────────

  describe("generate & install & uninstall integration", () => {
    it("escapes PROJECT_ROOT and quotes runner path even with spaces and passes node --check", async () => {
      await withTempDir(async (baseDir) => {
        const dirWithSpaces = join(baseDir, "my cursor project");
        await mkdir(dirWithSpaces, { recursive: true });
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dirWithSpaces);

        try {
          const configs = await adapter.generate([testHook]);
          expect(configs).toHaveLength(2);

          const runner = configs.find((c) => c.path === ".cursor/hooks/ai-tools-hooks-runner.js");
          const hooksJson = configs.find((c) => c.path === ".cursor/hooks.json");
          expect(runner).toBeDefined();
          expect(hooksJson).toBeDefined();

          // Verify PROJECT_ROOT uses JSON.stringify
          expect(runner!.content).toContain(
            `const PROJECT_ROOT = ${JSON.stringify(dirWithSpaces)};`,
          );
          expect(runner!.content).toContain("user_message");
          expect(runner!.content).toContain("agent_message");

          // Verify quoted absolute runner path in hooks.json
          const parsed = JSON.parse(hooksJson!.content) as {
            version: number;
            hooks: Record<string, Array<{ command: string }>>;
          };
          expect(parsed.version).toBe(1);
          const cmd = parsed.hooks.beforeShellExecution![0]!.command;
          expect(cmd).toMatch(/^node ".*" beforeShellExecution$/);
          const quotedPath = cmd.slice('node "'.length, -'" beforeShellExecution'.length);
          expect(isAbsolute(quotedPath)).toBe(true);
          expect(quotedPath).toContain("my cursor project");
          expect(
            quotedPath.endsWith(`${sep}.cursor${sep}hooks${sep}ai-tools-hooks-runner.js`),
          ).toBe(true);

          // Install to disk and syntax-check generated runner with real `node --check`
          await adapter.install(configs);
          const installedRunner = join(dirWithSpaces, ".cursor/hooks/ai-tools-hooks-runner.js");
          expect(existsSync(installedRunner)).toBe(true);
          expect(() => execFileSync(process.execPath, ["--check", installedRunner])).not.toThrow();
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });

    it("merges non-destructively into existing .cursor/hooks.json on generate/install and removes only ai-tools entries on uninstall", async () => {
      await withTempDir(async (dir) => {
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

        try {
          await mkdir(join(dir, ".cursor"), { recursive: true });
          await writeFile(
            join(dir, ".cursor/hooks.json"),
            JSON.stringify(
              {
                version: 1,
                customFlag: true,
                hooks: {
                  beforeShellExecution: [
                    { command: "echo user-shell-hook" },
                    { command: 'node "/old/ai-tools-hooks-runner.js" beforeShellExecution' },
                  ],
                  afterFileEdit: [{ command: "echo user-edit-hook" }],
                },
              },
              null,
              2,
            ),
            "utf-8",
          );

          const configs = await adapter.generate([
            {
              id: "multi",
              name: "Multi",
              events: ["shell:before", "prompt:submit"],
              phase: "before",
              handler: makeHandler(),
            },
          ]);
          await adapter.install(configs);

          const afterInstall = JSON.parse(
            await readFile(join(dir, ".cursor/hooks.json"), "utf-8"),
          ) as {
            version: number;
            customFlag: boolean;
            hooks: Record<string, Array<{ command: string }>>;
          };

          expect(afterInstall.version).toBe(1);
          expect(afterInstall.customFlag).toBe(true);
          // Preserves user hook, replaces old ai-tools hook without duplicating
          expect(afterInstall.hooks.beforeShellExecution).toHaveLength(2);
          expect(afterInstall.hooks.beforeShellExecution![0]!.command).toBe("echo user-shell-hook");
          expect(afterInstall.hooks.beforeShellExecution![1]!.command).toContain(
            "ai-tools-hooks-runner.js",
          );
          expect(afterInstall.hooks.afterFileEdit).toEqual([{ command: "echo user-edit-hook" }]);
          expect(afterInstall.hooks.beforeSubmitPrompt).toHaveLength(1);

          // Uninstall removes runner and ONLY ai-tools entries
          await adapter.uninstall();
          expect(existsSync(join(dir, ".cursor/hooks/ai-tools-hooks-runner.js"))).toBe(false);
          expect(existsSync(join(dir, ".cursor/hooks.json"))).toBe(true);

          const afterUninstall = JSON.parse(
            await readFile(join(dir, ".cursor/hooks.json"), "utf-8"),
          ) as {
            customFlag: boolean;
            hooks: Record<string, Array<{ command: string }>>;
          };
          expect(afterUninstall.customFlag).toBe(true);
          expect(afterUninstall.hooks.beforeShellExecution).toEqual([
            { command: "echo user-shell-hook" },
          ]);
          expect(afterUninstall.hooks.afterFileEdit).toEqual([{ command: "echo user-edit-hook" }]);
          expect(afterUninstall.hooks.beforeSubmitPrompt).toBeUndefined();
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });

    it("removes .cursor/hooks.json on uninstall when only ai-tools entries exist", async () => {
      await withTempDir(async (dir) => {
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

        try {
          const configs = await adapter.generate([testHook]);
          await adapter.install(configs);
          expect(existsSync(join(dir, ".cursor/hooks.json"))).toBe(true);

          await adapter.uninstall();
          expect(existsSync(join(dir, ".cursor/hooks.json"))).toBe(false);
          expect(existsSync(join(dir, ".cursor/hooks/ai-tools-hooks-runner.js"))).toBe(false);
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });

    it("executes generated runner against Cursor stdin fixtures and validates stdout protocol", async () => {
      await withTempDir(async (dir) => {
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);

        try {
          const configs = await adapter.generate([testHook]);
          const runner = configs.find((c) => c.path === ".cursor/hooks/ai-tools-hooks-runner.js")!;

          const captureFile = join(dir, "captured-event.json");
          const shimFile = join(dir, "mock-hooks.mjs");
          const runnableFile = join(dir, "runnable-runner.mjs");

          await writeFile(
            shimFile,
            `import { existsSync, readFileSync, writeFileSync } from "node:fs";
export async function loadConfig() {
  return { hooks: [] };
}
export class HookEngine {
  async emit(event, toolInfo) {
    const existing = existsSync(${JSON.stringify(captureFile)})
      ? JSON.parse(readFileSync(${JSON.stringify(captureFile)}, "utf-8"))
      : { events: [], toolInfo };
    existing.events.push(event);
    existing.event = existing.events[0];
    existing.toolInfo = toolInfo;
    writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify(existing), "utf-8");
    if (process.env.TEST_BLOCK_REASON) {
      return [{ blocked: true, reason: process.env.TEST_BLOCK_REASON }];
    }
    return [{ blocked: false }];
  }
}
`,
            "utf-8",
          );

          const runnableContent = runner.content.replace(
            '"@itz4blitz/ai-tools-hooks"',
            JSON.stringify(pathToFileURL(shimFile).href),
          );
          await writeFile(runnableFile, runnableContent, "utf-8");

          const invoke = (
            eventName: string,
            payload: Record<string, unknown>,
            blockReason?: string,
          ) => {
            if (existsSync(captureFile)) {
              execFileSync(process.execPath, [
                "-e",
                `require("node:fs").rmSync(${JSON.stringify(captureFile)}, { force: true })`,
              ]);
            }
            const stdout = execFileSync(process.execPath, [runnableFile, eventName], {
              input: JSON.stringify(payload),
              encoding: "utf-8",
              env: {
                ...process.env,
                TEST_BLOCK_REASON: blockReason ?? "",
              },
            });
            const captured = JSON.parse(
              execFileSync(
                process.execPath,
                [
                  "-e",
                  `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(captureFile)}, "utf-8"))`,
                ],
                { encoding: "utf-8" },
              ),
            ) as {
              event: Record<string, unknown>;
              events: Array<Record<string, unknown>>;
              toolInfo: Record<string, unknown>;
            };
            return { stdout: stdout.trim() ? JSON.parse(stdout) : null, captured };
          };

          // 1. beforeSubmitPrompt allow & block
          const promptAllow = invoke("beforeSubmitPrompt", { prompt: "hello world" });
          expect(promptAllow.captured.event.type).toBe("prompt:submit");
          expect(promptAllow.captured.event.prompt).toBe("hello world");
          expect(promptAllow.stdout).toEqual({ continue: true });

          const promptBlock = invoke("beforeSubmitPrompt", { prompt: "secret" }, "No secrets");
          expect(promptBlock.stdout).toEqual({
            continue: false,
            user_message: "No secrets",
            agent_message: "No secrets",
          });

          // 2. beforeReadFile with file_path -> permission allow / deny
          const readAllow = invoke("beforeReadFile", { file_path: ".env" });
          expect(readAllow.captured.event.type).toBe("file:read");
          expect(readAllow.captured.event.path).toBe(".env");
          expect(readAllow.stdout).toEqual({ permission: "allow" });

          const readDeny = invoke("beforeReadFile", { file_path: ".env" }, "Blocked env read");
          expect(readDeny.stdout).toEqual({
            permission: "deny",
            user_message: "Blocked env read",
            agent_message: "Blocked env read",
          });

          // 3. beforeShellExecution with cwd -> permission allow / deny
          const shellDeny = invoke(
            "beforeShellExecution",
            { command: "rm -rf /", cwd: "/tmp/proj" },
            "Dangerous command",
          );
          expect(shellDeny.captured.event.type).toBe("shell:before");
          expect(shellDeny.captured.event.command).toBe("rm -rf /");
          expect(shellDeny.captured.event.cwd).toBe("/tmp/proj");
          expect(shellDeny.stdout).toEqual({
            permission: "deny",
            user_message: "Dangerous command",
            agent_message: "Dangerous command",
          });

          // 4. beforeMCPExecution with server_name, tool_name, arguments
          const mcpAllow = invoke("beforeMCPExecution", {
            server_name: "linear",
            tool_name: "create_issue",
            arguments: { title: "Bug" },
          });
          expect(mcpAllow.captured.event.type).toBe("mcp:before");
          expect(mcpAllow.captured.event.server).toBe("linear");
          expect(mcpAllow.captured.event.method).toBe("create_issue");
          expect(mcpAllow.captured.event.params).toEqual({ title: "Bug" });
          expect(mcpAllow.stdout).toEqual({ permission: "allow" });

          // 5. preToolUse with tool_name & tool_input
          const toolBefore = invoke("preToolUse", {
            tool_name: "Edit",
            tool_input: { file_path: "src/a.ts" },
          });
          expect(toolBefore.captured.event.type).toBe("tool:before");
          expect(toolBefore.captured.event.toolName).toBe("Edit");
          expect(toolBefore.captured.event.input).toEqual({ file_path: "src/a.ts" });
          expect(toolBefore.stdout).toEqual({ permission: "allow" });

          // 6. afterFileEdit with file_path & edits emits both file:edit and file:write
          const fileEdit = invoke("afterFileEdit", {
            file_path: "src/app.ts",
            edits: [{ old_string: "foo", new_string: "bar" }],
          });
          expect(fileEdit.captured.events.map((e) => e.type)).toEqual(["file:edit", "file:write"]);
          expect(fileEdit.captured.event.path).toBe("src/app.ts");
          expect(fileEdit.captured.event.oldContent).toBe("foo");
          expect(fileEdit.captured.event.newContent).toBe("bar");
          expect(fileEdit.captured.events[1]?.content).toBe("bar");
          expect(fileEdit.stdout).toBeNull();

          // 7. sessionStart with cwd & afterAgentResponse with text
          const sessStart = invoke("sessionStart", { cwd: "/workspace/app" });
          expect(sessStart.captured.event.type).toBe("session:start");
          expect(sessStart.captured.event.workingDirectory).toBe("/workspace/app");

          const resp = invoke("afterAgentResponse", { text: "Done!", model: "claude-4" });
          expect(resp.captured.event.type).toBe("prompt:response");
          expect(resp.captured.event.response).toBe("Done!");
          expect(resp.captured.event.model).toBe("claude-4");
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });
  });

  describe("detect", () => {
    it("returns true when .cursor directory exists in cwd", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".cursor"), { recursive: true });
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
        try {
          expect(await adapter.detect()).toBe(true);
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });
  });
});
