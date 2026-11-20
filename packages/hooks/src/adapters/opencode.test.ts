import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";

vi.mock("./index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./index.js")>();
  return {
    ...actual,
    registry: { register: vi.fn() },
  };
});

import { OpenCodeAdapter } from "./opencode.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-hooks-opencode-"));
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

/**
 * Compile and instantiate the generated ESM plugin code by replacing its package
 * import with injected `loadConfig` and `HookEngine` mocks. This validates JS syntax
 * (including Windows paths in PROJECT_ROOT) and lets us execute the real hook handlers.
 */
function loadGeneratedPlugin(
  code: string,
  mocks: {
    loadConfig: (configPath?: string, cwd?: string) => Promise<unknown>;
    HookEngine: new (config: unknown) => {
      emit: (
        event: unknown,
        toolInfo: unknown,
      ) => Promise<Array<{ blocked?: boolean; reason?: string }>>;
    };
  },
): (ctx?: {
  project?: { worktree?: string };
  directory?: string;
}) => Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
  const transformed = code
    .replace(
      /import\s*\{[^}]*\}\s*from\s*["']@itz4blitz\/ai-tools-hooks["'];/,
      "const { loadConfig, HookEngine } = __mocks;",
    )
    .replace(/export\s+const\s+AiHooksPlugin\s*=/, "const AiHooksPlugin =");

  return runInNewContext(`(() => {\n${transformed}\nreturn AiHooksPlugin;\n})()`, {
    __mocks: mocks,
  }) as (ctx?: {
    project?: { worktree?: string };
    directory?: string;
  }) => Promise<Record<string, (...args: unknown[]) => Promise<unknown>>>;
}

describe("OpenCodeAdapter", () => {
  let adapter: OpenCodeAdapter;

  const testHook: HookDefinition = {
    id: "test",
    name: "Test Hook",
    events: ["shell:before"],
    phase: "before",
    handler: makeHandler(),
  };

  beforeEach(() => {
    adapter = new OpenCodeAdapter();
  });

  // ── Metadata / Capabilities ────────────────────────────────

  describe("metadata & capabilities", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("opencode");
      expect(adapter.name).toBe("OpenCode");
      expect(adapter.version).toBe("1.0");
    });

    it("declares expected capabilities", () => {
      expect(adapter.capabilities.beforeHooks).toBe(true);
      expect(adapter.capabilities.afterHooks).toBe(true);
      expect(adapter.capabilities.mcp).toBe(true);
      expect(adapter.capabilities.configFile).toBe(true);
      for (const event of adapter.capabilities.blockableEvents) {
        expect(adapter.capabilities.supportedEvents).toContain(event);
      }
    });
  });

  // ── Event Mapping ──────────────────────────────────────────

  describe("event mapping", () => {
    it("maps universal events to native OpenCode events", () => {
      expect(adapter.mapEvent("session:start")).toEqual(["session.created"]);
      expect(adapter.mapEvent("session:end")).toEqual(["session.idle"]);
      expect(adapter.mapEvent("prompt:submit")).toEqual(["message.updated"]);
      expect(adapter.mapEvent("prompt:response")).toEqual(["message.part.updated"]);
      expect(adapter.mapEvent("tool:before")).toEqual(["tool.execute.before"]);
      expect(adapter.mapEvent("tool:after")).toEqual(["tool.execute.after"]);
      expect(adapter.mapEvent("file:write")).toEqual(["tool.execute.before", "file.edited"]);
      expect(adapter.mapEvent("notification")).toEqual(["tui.toast.show"]);
      expect(adapter.mapEvent("unknown:event" as HookEventType)).toEqual([]);
    });

    it("maps native OpenCode events back to universal events", () => {
      expect(adapter.mapNativeEvent("session.created")).toEqual(["session:start"]);
      expect(adapter.mapNativeEvent("session.idle")).toEqual(["session:end"]);
      expect(adapter.mapNativeEvent("tool.execute.before")).toContain("shell:before");
      expect(adapter.mapNativeEvent("tool.execute.after")).toContain("shell:after");
      expect(adapter.mapNativeEvent("file.edited")).toEqual(["file:write", "file:edit"]);
      expect(adapter.mapNativeEvent("tui.toast.show")).toEqual(["notification"]);
      expect(adapter.mapNativeEvent("unknown.event")).toEqual([]);
    });
  });

  // ── Generate & Execute Plugin ──────────────────────────────

  describe("generate", () => {
    it("emits plugin JS and .opencode/package.json (not nested .opencode/plugins/package.json)", async () => {
      const configs = await adapter.generate([testHook]);
      expect(configs).toHaveLength(2);
      expect(configs.map((c) => c.path)).toEqual([
        ".opencode/plugins/ai-tools-hooks-plugin.js",
        ".opencode/package.json",
      ]);

      const pkg = JSON.parse(configs[1]!.content) as {
        type: string;
        dependencies: Record<string, string>;
      };
      expect(pkg.type).toBe("module");
      expect(pkg.dependencies["@itz4blitz/ai-tools-hooks"]).toBe("*");
    });

    it("escapes PROJECT_ROOT via JSON.stringify and does not call process.chdir", async () => {
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("C:\\Users\\dev\\my-repo");
      try {
        const configs = await adapter.generate([testHook]);
        const pluginCode = configs[0]!.content;
        expect(pluginCode).toContain(
          `const PROJECT_ROOT = ${JSON.stringify(resolve("C:\\Users\\dev\\my-repo"))};`,
        );
        expect(pluginCode).not.toContain("process.chdir");

        // Must parse as valid JS with Windows backslashes
        const pluginFactory = loadGeneratedPlugin(pluginCode, {
          loadConfig: vi.fn().mockResolvedValue({ hooks: [] }),
          HookEngine: class {
            emit = vi.fn().mockResolvedValue([]);
          },
        });
        expect(typeof pluginFactory).toBe("function");
      } finally {
        cwdSpy.mockRestore();
      }
    });

    it("routes bus lifecycle events through event handler and tool hooks at top level", async () => {
      const allHooks: HookDefinition[] = [
        {
          id: "all",
          name: "All",
          events: [
            "session:start",
            "session:end",
            "file:write",
            "prompt:submit",
            "prompt:response",
            "notification",
            "shell:before",
            "shell:after",
          ],
          phase: "before",
          handler: makeHandler(),
        },
      ];

      const configs = await adapter.generate(allHooks);
      const pluginCode = configs[0]!.content;

      const emitted: Array<{ event: Record<string, unknown>; toolInfo: unknown }> = [];
      const loadConfigMock = vi.fn().mockResolvedValue({ hooks: [] });

      class MockHookEngine {
        async emit(event: Record<string, unknown>, toolInfo: unknown) {
          emitted.push({ event, toolInfo });
          if (event.type === "shell:before" && event.command === "rm -rf /") {
            return [{ blocked: true, reason: "Dangerous command blocked" }];
          }
          return [];
        }
      }

      const AiHooksPlugin = loadGeneratedPlugin(pluginCode, {
        loadConfig: loadConfigMock,
        HookEngine: MockHookEngine,
      });

      const hooks = await AiHooksPlugin({ directory: "/workspace/demo" });
      expect(typeof hooks.event).toBe("function");
      expect(typeof hooks["tool.execute.before"]).toBe("function");
      expect(typeof hooks["tool.execute.after"]).toBe("function");

      // Bus events
      await hooks.event!({ event: { type: "session.created", properties: {} } });
      await hooks.event!({ event: { type: "file.edited", properties: { file: "src/index.ts" } } });
      await hooks.event!({ event: { type: "tui.toast.show", properties: { message: "Done" } } });

      expect(loadConfigMock).toHaveBeenCalledWith(undefined, "/workspace/demo");
      expect(emitted[0]!.event).toMatchObject({
        type: "session:start",
        workingDirectory: "/workspace/demo",
      });
      expect(emitted[1]!.event).toMatchObject({
        type: "file:edit",
        path: "src/index.ts",
      });
      expect(emitted[2]!.event).toMatchObject({
        type: "notification",
        message: "Done",
      });

      // tool.execute.before reading output.args (edit with filePath/oldString/newString)
      await hooks["tool.execute.before"]!(
        { tool: "edit", sessionID: "s1", callID: "c1" },
        { args: { filePath: "src/app.ts", oldString: "foo", newString: "bar" } },
      );
      expect(emitted[3]!.event).toMatchObject({
        type: "file:edit",
        path: "src/app.ts",
        oldContent: "foo",
        newContent: "bar",
      });

      // tool.execute.before throwing Error on block
      await expect(
        hooks["tool.execute.before"]!(
          { tool: "bash", sessionID: "s1", callID: "c2" },
          { args: { command: "rm -rf /" } },
        ),
      ).rejects.toThrow("Dangerous command blocked");

      // tool.execute.after
      await hooks["tool.execute.after"]!(
        { tool: "bash", args: { command: "echo hi" } },
        { output: "hi\n", metadata: { exit: 0 } },
      );
      expect(emitted[5]!.event).toMatchObject({
        type: "shell:after",
        command: "echo hi",
        stdout: "hi\n",
        exitCode: 0,
      });
    });
  });

  // ── Install / Uninstall / Detect (Real Temp Dir) ───────────

  describe("install, uninstall, and detect", () => {
    it("merges .opencode/package.json safely on install and cleans up on uninstall", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".opencode"), { recursive: true });
        await writeFile(
          join(dir, ".opencode/package.json"),
          JSON.stringify({ name: "my-plugins", dependencies: { "other-pkg": "^1.0.0" } }, null, 2),
        );

        const configs = await adapter.generate([testHook]);
        await adapter.install(configs, dir);

        expect(existsSync(join(dir, ".opencode/plugins/ai-tools-hooks-plugin.js"))).toBe(true);
        const installedPkg = JSON.parse(
          await readFile(join(dir, ".opencode/package.json"), "utf-8"),
        ) as { name: string; dependencies: Record<string, string> };
        expect(installedPkg.name).toBe("my-plugins");
        expect(installedPkg.dependencies["other-pkg"]).toBe("^1.0.0");
        expect(installedPkg.dependencies["@itz4blitz/ai-tools-hooks"]).toBe("*");

        // Uninstall preserves other-pkg and removes plugin + hooks dep
        await adapter.uninstall(dir);
        expect(existsSync(join(dir, ".opencode/plugins/ai-tools-hooks-plugin.js"))).toBe(false);
        const remainingPkg = JSON.parse(
          await readFile(join(dir, ".opencode/package.json"), "utf-8"),
        ) as { name: string; dependencies: Record<string, string> };
        expect(remainingPkg.dependencies["other-pkg"]).toBe("^1.0.0");
        expect(remainingPkg.dependencies["@itz4blitz/ai-tools-hooks"]).toBeUndefined();
      });
    });

    it("deletes .opencode/package.json on uninstall when it only contained hooks dependency", async () => {
      await withTempDir(async (dir) => {
        const configs = await adapter.generate([testHook]);
        await adapter.install(configs, dir);
        expect(existsSync(join(dir, ".opencode/package.json"))).toBe(true);

        await adapter.uninstall(dir);
        expect(existsSync(join(dir, ".opencode/package.json"))).toBe(false);
      });
    });

    it("detects .opencode, opencode.json, and opencode.jsonc in cwd", async () => {
      await withTempDir(async (dir) => {
        const cmdSpy = vi
          .spyOn(adapter as unknown as { commandExists: () => Promise<boolean> }, "commandExists")
          .mockResolvedValue(false);
        try {
          expect(await adapter.detect(dir)).toBe(false);

          await writeFile(join(dir, "opencode.jsonc"), "{ /* comment */ }\n");
          expect(await adapter.detect(dir)).toBe(true);

          await rm(join(dir, "opencode.jsonc"));
          await writeFile(join(dir, "opencode.json"), "{}\n");
          expect(await adapter.detect(dir)).toBe(true);

          await rm(join(dir, "opencode.json"));
          await mkdir(join(dir, ".opencode"));
          expect(await adapter.detect(dir)).toBe(true);
        } finally {
          cmdSpy.mockRestore();
        }
      });
    });
  });
});
