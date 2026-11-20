import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";

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
import { ZcodeAdapter } from "./zcode.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

const shellHook: HookDefinition = {
  id: "guard",
  name: "guard",
  events: ["shell:before" as HookEventType],
  phase: "before",
  handler: makeHandler(),
};

const sessionHook: HookDefinition = {
  id: "welcome",
  name: "welcome",
  events: ["session:start" as HookEventType],
  phase: "before",
  handler: makeHandler(),
};

describe("ZcodeAdapter", () => {
  let adapter: ZcodeAdapter;
  let tmp: string;
  let home: string;
  let previousCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "zcode-hooks-"));
    home = await mkdtemp(join(tmpdir(), "zcode-home-"));
    mockHome.value = home;
    adapter = new ZcodeAdapter();
    previousCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("uses ZCode identity, cross-platform user paths, and blockable file:read", () => {
    expect(adapter.id).toBe("zcode");
    expect(adapter.name).toBe("ZCode");
    expect(adapter.mapEvent("shell:before")).toEqual(["PreToolUse"]);
    expect(adapter.mapEvent("file:read")).toEqual(["PreToolUse"]);
    expect(adapter.mapEvent("session:end")).toEqual(["Stop"]);
    expect(adapter.mapEvent("notification")).toEqual([]);
    expect(adapter.mapNativeEvent("UserPromptSubmit")).toEqual(["prompt:submit"]);
    expect(adapter.mapNativeEvent("PermissionRequest")).toEqual(["tool:before"]);
    expect(adapter.capabilities.blockableEvents).toContain("file:read");
    expect(adapter.userConfigPath).toBe(join(home, ".zcode", "cli", "config.json"));
    expect(adapter.userHooksPath).toBe(join(home, ".zcode", "hooks.json"));
  });

  it("writes only .zcode/config.json and runner (no duplicate .zcode/hooks.json) with cross-platform command", async () => {
    const files = await adapter.generate([shellHook]);
    await adapter.install(files);

    expect(files.map((file) => file.path)).toEqual([
      ".zcode/config.json",
      ".zcode/hooks/ai-tools-runner.js",
    ]);
    expect(existsSync(join(tmp, ".zcode", "hooks.json"))).toBe(false);

    const expectedRunnerPath = resolve(process.cwd(), ".zcode/hooks/ai-tools-runner.js").replaceAll(
      "\\",
      "/",
    );
    const expectedCommand = `node ${JSON.stringify(expectedRunnerPath)}`;
    expect(expectedCommand).not.toContain("${ZCODE_PROJECT_DIR}");

    expect(JSON.parse(await readFile(join(tmp, ".zcode", "config.json"), "utf-8"))).toEqual({
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: expectedCommand,
                  timeout: 10,
                  statusMessage: "ai-hooks",
                },
              ],
            },
          ],
        },
      },
    });

    // Importing right after install must not return duplicate entries
    const imported = await adapter.import(tmp);
    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe(expectedCommand);

    const runner = await readFile(join(tmp, ".zcode", "hooks", "ai-tools-runner.js"), "utf-8");
    expect(runner.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(runner).toContain('import { runZcodeHook } from "@itz4blitz/ai-tools-hooks"');
    expect(runner).toContain("process.exit(await runZcodeHook())");
    expect(runner).not.toMatch(/process\.exit\(0\);\s*$/);
  });

  it("merges generated hooks into an existing .zcode/config.json and deletes empty event arrays", async () => {
    await mkdir(join(tmp, ".zcode"), { recursive: true });
    await writeFile(
      join(tmp, ".zcode", "config.json"),
      `${JSON.stringify({
        model: "keep-me",
        hooks: {
          enabled: false,
          events: {
            Stop: [
              {
                hooks: [{ type: "command", command: "echo custom", timeout: 5 }],
              },
            ],
            PreToolUse: [
              {
                hooks: [
                  { type: "command", command: 'node "/old/.zcode/hooks/ai-tools-runner.js"' },
                ],
              },
            ],
          },
        },
      })}\n`,
      "utf-8",
    );

    // Regenerate with only session:start -> old PreToolUse ai-hooks entry should be removed entirely (no empty [])
    await adapter.install(await adapter.generate([sessionHook]));
    const config = JSON.parse(await readFile(join(tmp, ".zcode", "config.json"), "utf-8")) as {
      model: string;
      hooks: { enabled: boolean; events: Record<string, unknown[]> };
    };
    expect(config.model).toBe("keep-me");
    expect(config.hooks.enabled).toBe(true);
    expect(config.hooks.events.Stop).toHaveLength(1);
    expect(config.hooks.events.SessionStart).toHaveLength(1);
    expect(config.hooks.events.PreToolUse).toBeUndefined();
  });

  it("detects a project .zcode directory", async () => {
    expect(await adapter.detect()).toBe(false);
    await mkdir(join(tmp, ".zcode"));
    expect(await adapter.detect()).toBe(true);
  });

  it("detects user ~/.zcode/hooks.json without a zcode binary", async () => {
    await mkdir(join(home, ".zcode"), { recursive: true });
    await writeFile(join(home, ".zcode", "hooks.json"), "{}\n", "utf-8");
    expect(await adapter.detect()).toBe(true);
  });

  it("detects the zcode command", async () => {
    vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof execFile);
    expect(await adapter.detect()).toBe(true);
  });

  it("imports workspace hooks.json and config.json events", async () => {
    await mkdir(join(tmp, ".zcode"), { recursive: true });
    await writeFile(
      join(tmp, ".zcode", "hooks.json"),
      `${JSON.stringify({
        version: 1,
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo session", timeout: 30 }] }],
        },
      })}\n`,
      "utf-8",
    );
    await writeFile(
      join(tmp, ".zcode", "config.json"),
      `${JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: "/usr/bin/dcg", timeout: 5 }],
              },
            ],
          },
        },
      })}\n`,
      "utf-8",
    );

    const imported = await adapter.import(tmp);
    expect(imported.map((hook) => hook.name).toSorted()).toEqual(["/usr/bin/dcg", "echo session"]);
    const session = imported.find((hook) => hook.name === "echo session");
    expect(session?.events).toEqual(["session:start"]);
    expect(session?.phase).toBe("before");
    const pre = imported.find((hook) => hook.name === "/usr/bin/dcg");
    expect(pre?.events).toContain("shell:before");
  });

  it("imports user ~/.zcode/hooks.json and cli/config.json hooks.events", async () => {
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(
      join(home, ".zcode", "hooks.json"),
      `${JSON.stringify({
        version: 1,
        hooks: {
          Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo stop", timeout: 20 }] }],
        },
      })}\n`,
      "utf-8",
    );
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      `${JSON.stringify({
        model: "keep-me",
        hooks: {
          enabled: true,
          events: {
            UserPromptSubmit: [
              { matcher: "", hooks: [{ type: "command", command: "echo prompt", timeout: 20 }] },
            ],
          },
        },
      })}\n`,
      "utf-8",
    );

    const imported = await adapter.importUser();
    expect(imported.map((hook) => hook.name).toSorted()).toEqual(["echo prompt", "echo stop"]);
    expect(imported.find((hook) => hook.name === "echo prompt")?.events).toEqual(["prompt:submit"]);
    expect(imported.find((hook) => hook.name === "echo stop")?.events).toContain("session:end");
  });

  it("imports zcode.json workspace config and ignores invalid JSON", async () => {
    await writeFile(
      join(tmp, "zcode.json"),
      `${JSON.stringify({
        hooks: {
          enabled: true,
          events: {
            PostToolUse: [{ hooks: [{ type: "command", command: "echo after" }] }],
          },
        },
      })}\n`,
      "utf-8",
    );
    await mkdir(join(tmp, ".zcode"), { recursive: true });
    await writeFile(join(tmp, ".zcode", "config.json"), "[1,2,3]", "utf-8");
    await writeFile(join(tmp, ".zcode", "hooks.json"), "{not-json", "utf-8");
    const imported = await adapter.import();
    expect(imported.map((hook) => hook.name)).toEqual(["echo after"]);
    expect(imported[0]?.phase).toBe("after");
  });

  it("detects user ~/.zcode/cli/config.json", async () => {
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(join(home, ".zcode", "cli", "config.json"), "{}\n", "utf-8");
    expect(await adapter.detect()).toBe(true);
  });

  it("maps unknown events to empty arrays and imports nothing from missing user files", async () => {
    expect(adapter.mapEvent("unknown:event" as HookEventType)).toEqual([]);
    expect(adapter.mapNativeEvent("NotAThing")).toEqual([]);
    expect(await adapter.importUser()).toEqual([]);
  });

  it("does not rewrite missing workspace config on uninstall", async () => {
    await adapter.uninstall();
    expect(existsSync(join(tmp, ".zcode", "config.json"))).toBe(false);
  });

  it("preserves non-command matcher groups while replacing ai-hooks entries", async () => {
    await mkdir(join(tmp, ".zcode"), { recursive: true });
    await writeFile(
      join(tmp, ".zcode", "config.json"),
      `${JSON.stringify({
        hooks: {
          events: {
            PreToolUse: "not-an-array",
            Stop: [
              { matcher: "x" },
              {
                hooks: [{ type: "command", command: 'node "/x/.zcode/hooks/ai-tools-runner.js"' }],
              },
            ],
          },
        },
      })}\n`,
      "utf-8",
    );
    await adapter.install(await adapter.generate([shellHook]));
    const config = JSON.parse(await readFile(join(tmp, ".zcode", "config.json"), "utf-8")) as {
      hooks: { events: Record<string, unknown[]> };
    };
    expect(config.hooks.events.PreToolUse).toHaveLength(1);
    expect(config.hooks.events.Stop).toHaveLength(1);
  });

  it("uninstalls runner and strips only ai-hooks entries, removing empty hooks block", async () => {
    const configPath = join(tmp, ".zcode", "config.json");
    await mkdir(join(tmp, ".zcode"), { recursive: true });

    // Case 1: preserves custom Stop hook
    await writeFile(
      configPath,
      `${JSON.stringify({
        model: "keep-me",
        hooks: {
          enabled: true,
          events: {
            Stop: [{ hooks: [{ type: "command", command: "echo custom" }] }],
          },
        },
      })}\n`,
      "utf-8",
    );
    await adapter.install(await adapter.generate([shellHook]));
    await adapter.uninstall();

    expect(existsSync(join(tmp, ".zcode", "hooks", "ai-tools-runner.js"))).toBe(false);
    const config = JSON.parse(await readFile(configPath, "utf-8")) as {
      model: string;
      hooks: { events: Record<string, unknown[]> };
    };
    expect(config.model).toBe("keep-me");
    expect(config.hooks.events.Stop).toHaveLength(1);
    expect(config.hooks.events.PreToolUse).toBeUndefined();

    // Case 2: removes empty hooks block while preserving model
    await writeFile(configPath, `${JSON.stringify({ model: "keep-me" })}\n`, "utf-8");
    await adapter.install(await adapter.generate([shellHook]));
    await adapter.uninstall();
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({ model: "keep-me" });

    // Case 3: removes config.json completely if it has no remaining keys
    await rm(configPath, { force: true });
    await adapter.install(await adapter.generate([shellHook]));
    await adapter.uninstall();
    expect(existsSync(configPath)).toBe(false);
  });
});
