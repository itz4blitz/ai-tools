import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";
import { ClineAdapter, getClineGlobalStoragePath } from "./cline.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

describe("ClineAdapter", () => {
  let adapter: ClineAdapter;
  let tempDir: string;

  const testHook: HookDefinition = {
    id: "test",
    name: "Test Hook",
    events: ["shell:before"],
    phase: "before",
    handler: makeHandler(),
  };

  beforeEach(async () => {
    adapter = new ClineAdapter();
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-cline-hooks-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── Metadata / Capabilities ────────────────────────────────

  describe("metadata", () => {
    it("has correct id, name, and version", () => {
      expect(adapter.id).toBe("cline");
      expect(adapter.name).toBe("Cline");
      expect(adapter.version).toBe("1.0");
    });
  });

  describe("capabilities", () => {
    it("supports beforeHooks, afterHooks, mcp, and configFile", () => {
      expect(adapter.capabilities.beforeHooks).toBe(true);
      expect(adapter.capabilities.afterHooks).toBe(true);
      expect(adapter.capabilities.mcp).toBe(true);
      expect(adapter.capabilities.configFile).toBe(true);
    });

    it("lists all supported events", () => {
      const expected: HookEventType[] = [
        "session:start",
        "session:end",
        "prompt:submit",
        "tool:before",
        "tool:after",
        "file:read",
        "file:write",
        "file:edit",
        "file:delete",
        "shell:before",
        "shell:after",
        "mcp:before",
        "mcp:after",
      ];
      expect(adapter.capabilities.supportedEvents).toEqual(expected);
    });

    it("lists all blockable events including prompt:submit", () => {
      const expected: HookEventType[] = [
        "prompt:submit",
        "tool:before",
        "file:read",
        "file:write",
        "file:edit",
        "file:delete",
        "shell:before",
        "mcp:before",
      ];
      expect(adapter.capabilities.blockableEvents).toEqual(expected);
      for (const event of adapter.capabilities.blockableEvents) {
        expect(adapter.capabilities.supportedEvents).toContain(event);
      }
    });
  });

  // ── mapEvent / mapNativeEvent ──────────────────────────────

  describe("mapEvent", () => {
    it("maps universal events to Cline native events", () => {
      expect(adapter.mapEvent("session:start")).toEqual(["TaskStart"]);
      expect(adapter.mapEvent("session:end")).toEqual(["TaskCancel"]);
      expect(adapter.mapEvent("prompt:submit")).toEqual(["UserPromptSubmit"]);
      expect(adapter.mapEvent("prompt:response")).toEqual([]);
      expect(adapter.mapEvent("tool:before")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("tool:after")).toEqual(["PostToolUse"]);
      expect(adapter.mapEvent("file:read")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("file:write")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("file:edit")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("file:delete")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("shell:before")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("shell:after")).toEqual(["PostToolUse"]);
      expect(adapter.mapEvent("mcp:before")).toEqual(["PreToolUse"]);
      expect(adapter.mapEvent("mcp:after")).toEqual(["PostToolUse"]);
      expect(adapter.mapEvent("notification")).toEqual([]);
      expect(adapter.mapEvent("unknown:event" as HookEventType)).toEqual([]);
    });
  });

  describe("mapNativeEvent", () => {
    it("maps Cline native events back to universal events", () => {
      expect(adapter.mapNativeEvent("TaskStart")).toEqual(["session:start"]);
      expect(adapter.mapNativeEvent("TaskResume")).toEqual(["session:start"]);
      expect(adapter.mapNativeEvent("TaskCancel")).toEqual(["session:end"]);
      expect(adapter.mapNativeEvent("UserPromptSubmit")).toEqual(["prompt:submit"]);
      expect(adapter.mapNativeEvent("PreToolUse")).toEqual([
        "tool:before",
        "file:read",
        "file:write",
        "file:edit",
        "file:delete",
        "shell:before",
        "mcp:before",
      ]);
      expect(adapter.mapNativeEvent("PostToolUse")).toEqual([
        "tool:after",
        "shell:after",
        "mcp:after",
      ]);
      expect(adapter.mapNativeEvent("PreCompact")).toEqual([]);
      expect(adapter.mapNativeEvent("UnknownNativeEvent")).toEqual([]);
    });
  });

  // ── generate ───────────────────────────────────────────────

  describe("generate", () => {
    it("generates deduplicated hook scripts with JSON-escaped PROJECT_ROOT", async () => {
      const hooks: HookDefinition[] = [
        testHook,
        {
          id: "file-guard",
          name: "File Guard",
          events: ["file:write", "mcp:after", "prompt:submit"],
          phase: "before",
          handler: makeHandler(),
        },
      ];
      const configs = await adapter.generate(hooks);
      const paths = configs.map((c) => c.path);
      expect(paths).toContain(".clinerules/hooks/PreToolUse");
      expect(paths).toContain(".clinerules/hooks/PostToolUse");
      expect(paths).toContain(".clinerules/hooks/UserPromptSubmit");
      expect(paths.filter((p) => p.endsWith("PreToolUse"))).toHaveLength(1);

      const pre = configs.find((c) => c.path.endsWith("PreToolUse"))!;
      expect(pre.format).toBe("js");
      expect(pre.content).toContain("#!/usr/bin/env node");
      expect(pre.content).toContain(`const PROJECT_ROOT = ${JSON.stringify(process.cwd())};`);
      expect(pre.content).toContain("input.preToolUse");
      expect(pre.content).toContain("input.postToolUse");
      expect(pre.content).toContain("input.userPromptSubmit");
      expect(pre.content).toContain("contextModification");
      expect(pre.content).toContain('"mcp:after"');
    });

    it("returns empty array for empty or unmapped hooks", async () => {
      expect(await adapter.generate([])).toEqual([]);
      expect(
        await adapter.generate([
          {
            id: "unmapped",
            name: "Unmapped",
            events: ["prompt:response"],
            phase: "after",
            handler: makeHandler(),
          },
        ]),
      ).toEqual([]);
    });
  });

  // ── real temp-dir install / uninstall / detect ─────────────

  describe("install, uninstall, and detect", () => {
    it("installs scripts in temp dir (with .ps1 wrapper on win32 or 0755 on POSIX) and uninstalls cleanly", async () => {
      const configs = await adapter.generate([testHook]);
      await adapter.install(configs, tempDir);

      const hookPath = join(tempDir, ".clinerules", "hooks", "PreToolUse");
      expect(existsSync(hookPath)).toBe(true);

      if (process.platform === "win32") {
        const ps1Path = `${hookPath}.ps1`;
        expect(existsSync(ps1Path)).toBe(true);
        const ps1Content = await readFile(ps1Path, "utf-8");
        expect(ps1Content).toContain("PreToolUse");
        expect(ps1Content).toContain("& node");
      } else {
        const fileStat = await stat(hookPath);
        expect(fileStat.mode & 0o111).not.toBe(0);
      }

      await adapter.uninstall(tempDir);
      expect(existsSync(hookPath)).toBe(false);
      expect(existsSync(`${hookPath}.ps1`)).toBe(false);
    });

    it("detects .clinerules in provided cwd", async () => {
      await mkdir(join(tempDir, ".clinerules"), { recursive: true });
      expect(await adapter.detect(tempDir)).toBe(true);
    });

    it("resolves VS Code globalStorage path across macOS, Windows, and Linux", () => {
      expect(
        getClineGlobalStoragePath({ platform: "darwin", home: "/Users/dev", env: {} }),
      ).toContain("Library");
      expect(
        getClineGlobalStoragePath({
          platform: "win32",
          home: "C:\\Users\\dev",
          env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
        }),
      ).toContain("saoudrizwan.claude-dev");
      expect(
        getClineGlobalStoragePath({
          platform: "linux",
          home: "/home/dev",
          env: { XDG_CONFIG_HOME: "/home/dev/.xdg" },
        }),
      ).toContain(".xdg");
    });
  });

  // ── execute generated hook script against Cline v3.36+ STDIN JSON ──

  describe("generated runner execution", () => {
    async function runGeneratedScript(
      eventName: string,
      stdinPayload: Record<string, unknown>,
      mockResults: Array<Record<string, unknown>>,
    ): Promise<{ stdout: Record<string, unknown>; capturedEvent: Record<string, unknown> }> {
      const hookForEvent: HookDefinition = {
        id: "exec-test",
        name: "Exec Test",
        events: [
          "session:start",
          "prompt:submit",
          "shell:before",
          "shell:after",
          "mcp:before",
          "mcp:after",
        ],
        phase: "before",
        handler: makeHandler(),
      };
      const configs = await adapter.generate([hookForEvent]);
      const config = configs.find((c) => c.path === `.clinerules/hooks/${eventName}`);
      expect(config).toBeDefined();

      const eventCapturePath = join(tempDir, "captured-event.json");
      const mockPkgPath = join(tempDir, "mock-hooks.mjs");
      await writeFile(
        mockPkgPath,
        [
          'import { writeFileSync } from "node:fs";',
          "export async function loadConfig() { return { hooks: [] }; }",
          "export class HookEngine {",
          "  async emit(event) {",
          `    writeFileSync(${JSON.stringify(eventCapturePath)}, JSON.stringify(event), "utf-8");`,
          `    return ${JSON.stringify(mockResults)};`,
          "  }",
          "}",
        ].join("\n"),
        "utf-8",
      );

      const runnerPath = join(tempDir, `${eventName}.mjs`);
      const patchedContent = config!.content
        .replace('"@itz4blitz/ai-tools-hooks"', JSON.stringify(pathToFileURL(mockPkgPath).href))
        .replace(
          `const PROJECT_ROOT = ${JSON.stringify(process.cwd())};`,
          `const PROJECT_ROOT = ${JSON.stringify(tempDir)};`,
        );
      await writeFile(runnerPath, patchedContent, "utf-8");

      const rawStdout = execFileSync(process.execPath, [runnerPath], {
        input: JSON.stringify(stdinPayload),
        encoding: "utf-8",
      });

      const capturedEvent = JSON.parse(await readFile(eventCapturePath, "utf-8")) as Record<
        string,
        unknown
      >;
      return {
        stdout: JSON.parse(rawStdout) as Record<string, unknown>,
        capturedEvent,
      };
    }

    it("parses Cline v3.36+ preToolUse and blocks with errorMessage + contextModification", async () => {
      const { stdout, capturedEvent } = await runGeneratedScript(
        "PreToolUse",
        {
          hookName: "PreToolUse",
          taskId: "task-123",
          preToolUse: {
            toolName: "execute_command",
            parameters: { command: "rm -rf /tmp/danger" },
          },
        },
        [
          {
            blocked: true,
            reason: "Dangerous shell command",
            data: { additionalContext: "Use safe cleanup instead" },
          },
        ],
      );

      expect(capturedEvent.type).toBe("shell:before");
      expect(capturedEvent.command).toBe("rm -rf /tmp/danger");
      expect(stdout).toEqual({
        cancel: true,
        errorMessage: "Dangerous shell command",
        contextModification: "Use safe cleanup instead",
      });
    });

    it("parses Cline v3.36+ postToolUse for use_mcp_tool into mcp:after", async () => {
      const { stdout, capturedEvent } = await runGeneratedScript(
        "PostToolUse",
        {
          hookName: "PostToolUse",
          taskId: "task-456",
          postToolUse: {
            toolName: "use_mcp_tool",
            parameters: {
              server_name: "github",
              tool_name: "create_issue",
              arguments: JSON.stringify({ title: "Bug" }),
            },
            result: { issueNumber: 42 },
            success: true,
            executionTimeMs: 185,
          },
        },
        [{ blocked: false, data: { additionalContext: "MCP audit logged" } }],
      );

      expect(capturedEvent.type).toBe("mcp:after");
      expect(capturedEvent.server).toBe("github");
      expect(capturedEvent.method).toBe("create_issue");
      expect(capturedEvent.params).toEqual({ title: "Bug" });
      expect(capturedEvent.result).toEqual({ issueNumber: 42 });
      expect(capturedEvent.duration).toBe(185);
      expect(stdout).toEqual({
        cancel: false,
        contextModification: "MCP audit logged",
      });
    });

    it("parses Cline v3.36+ userPromptSubmit.prompt and forwards contextModification", async () => {
      const { stdout, capturedEvent } = await runGeneratedScript(
        "UserPromptSubmit",
        {
          hookName: "UserPromptSubmit",
          taskId: "task-789",
          userPromptSubmit: { prompt: "Refactor auth module" },
        },
        [{ blocked: false, data: { additionalContext: "Remember security guidelines" } }],
      );

      expect(capturedEvent.type).toBe("prompt:submit");
      expect(capturedEvent.prompt).toBe("Refactor auth module");
      expect(stdout).toEqual({
        cancel: false,
        contextModification: "Remember security guidelines",
      });
    });

    it("parses Cline v3.36+ taskStart and preserves backwards-compatible pendingToolInfo fallback", async () => {
      const taskRes = await runGeneratedScript(
        "TaskStart",
        {
          hookName: "TaskStart",
          taskId: "task-start-1",
          workspaceRoots: ["/workspace/app"],
          taskStart: { taskMetadata: { task: "Build feature" } },
        },
        [{ blocked: false }],
      );
      expect(taskRes.capturedEvent.type).toBe("session:start");
      expect(taskRes.capturedEvent.workingDirectory).toBe("/workspace/app");
      expect((taskRes.capturedEvent.metadata as Record<string, unknown>).taskStart).toEqual({
        taskMetadata: { task: "Build feature" },
      });

      const legacyRes = await runGeneratedScript(
        "PreToolUse",
        {
          hookName: "PreToolUse",
          taskId: "legacy-1",
          pendingToolInfo: { toolName: "read_file", path: "README.md" },
        },
        [{ blocked: false }],
      );
      expect(legacyRes.capturedEvent.type).toBe("file:read");
      expect(legacyRes.capturedEvent.path).toBe("README.md");
      expect(legacyRes.stdout).toEqual({ cancel: false });
    });
  });
});
