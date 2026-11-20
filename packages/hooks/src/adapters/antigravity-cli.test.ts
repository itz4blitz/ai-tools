import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { AntigravityCliAdapter } from "./antigravity-cli.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

const allEventsHook: HookDefinition = {
  id: "all",
  name: "all",
  events: [
    "session:start",
    "prompt:submit",
    "prompt:response",
    "session:end",
    "shell:before",
    "shell:after",
  ] as HookEventType[],
  phase: "before",
  handler: makeHandler(),
};

describe("AntigravityCliAdapter", () => {
  let adapter: AntigravityCliAdapter;
  let tmp: string;
  let home: string;
  let previousCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "agy-hooks-"));
    home = await mkdtemp(join(tmpdir(), "agy-home-"));
    mockHome.value = home;
    adapter = new AntigravityCliAdapter();
    previousCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("uses Antigravity CLI identity and maps native events", () => {
    expect(adapter.id).toBe("antigravity-cli");
    expect(adapter.name).toBe("Antigravity CLI");
    expect(adapter.userHooksPath).toBe(join(home, ".gemini", "config", "hooks.json"));
    expect(adapter.mapEvent("session:start")).toEqual(["SessionStart"]);
    expect(adapter.mapEvent("prompt:submit")).toEqual(["PreInvocation"]);
    expect(adapter.mapEvent("prompt:response")).toEqual(["PostInvocation"]);
    expect(adapter.mapEvent("session:end")).toEqual(["Stop"]);
    expect(adapter.mapEvent("shell:before")).toEqual(["PreToolUse"]);
    expect(adapter.mapEvent("shell:after")).toEqual(["PostToolUse"]);
    expect(adapter.mapEvent("notification")).toEqual([]);
    expect(adapter.mapNativeEvent("PreInvocation")).toEqual(["prompt:submit"]);
    expect(adapter.mapNativeEvent("PostToolUse")).toEqual([
      "tool:after",
      "shell:after",
      "mcp:after",
    ]);
  });

  it("generates .agents/hooks.json under ai-tools with grouped tool events and flat lifecycle events", async () => {
    const files = await adapter.generate([allEventsHook]);
    expect(files.map((f) => f.path)).toEqual([
      ".agents/hooks.json",
      ".agents/hooks/ai-tools-runner.js",
    ]);

    const parsed = JSON.parse(files[0]!.content) as {
      "ai-tools": Record<string, unknown[]>;
    };
    const group = parsed["ai-tools"];
    const expectedCmd = {
      type: "command",
      command: "node .agents/hooks/ai-tools-runner.js",
      timeout: 10,
    };

    expect(group.PreToolUse).toEqual([{ matcher: "*", hooks: [expectedCmd] }]);
    expect(group.PostToolUse).toEqual([{ matcher: "*", hooks: [expectedCmd] }]);
    expect(group.SessionStart).toEqual([expectedCmd]);
    expect(group.PreInvocation).toEqual([expectedCmd]);
    expect(group.PostInvocation).toEqual([expectedCmd]);
    expect(group.Stop).toEqual([expectedCmd]);

    const runner = files[1]!.content;
    expect(runner.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(runner).toContain('import { runAntigravityCliHook } from "@itz4blitz/ai-tools-hooks"');
    expect(runner).toContain(`const PROJECT_ROOT = ${JSON.stringify(process.cwd())};`);
    expect(runner).toContain("process.exit(await runAntigravityCliHook());");
  });

  it("merges only ai-tools on install and strips only ai-tools on uninstall", async () => {
    await mkdir(join(tmp, ".agents"), { recursive: true });
    await writeFile(
      join(tmp, ".agents/hooks.json"),
      JSON.stringify({
        "other-plugin": {
          SessionStart: [{ type: "command", command: "echo keep", timeout: 5 }],
        },
      }),
      "utf-8",
    );

    const files = await adapter.generate([allEventsHook]);
    await adapter.install(files);

    const installed = JSON.parse(
      await readFile(join(tmp, ".agents/hooks.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(installed["other-plugin"]).toBeDefined();
    expect(installed["ai-tools"]).toBeDefined();
    expect(existsSync(join(tmp, ".agents/hooks/ai-tools-runner.js"))).toBe(true);

    await adapter.uninstall();
    expect(existsSync(join(tmp, ".agents/hooks/ai-tools-runner.js"))).toBe(false);
    expect(existsSync(join(tmp, ".agents/hooks.json"))).toBe(true);

    const afterUninstall = JSON.parse(
      await readFile(join(tmp, ".agents/hooks.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(afterUninstall["other-plugin"]).toBeDefined();
    expect(afterUninstall["ai-tools"]).toBeUndefined();
  });

  it("removes .agents/hooks.json completely on uninstall when ai-tools was the only key", async () => {
    const files = await adapter.generate([allEventsHook]);
    await adapter.install(files);
    await adapter.uninstall();
    expect(existsSync(join(tmp, ".agents/hooks.json"))).toBe(false);
  });

  it("imports workspace and user hooks.json", async () => {
    await mkdir(join(tmp, ".agents"), { recursive: true });
    await writeFile(
      join(tmp, ".agents/hooks.json"),
      JSON.stringify({
        "ai-tools": {
          PreToolUse: [
            { matcher: "*", hooks: [{ type: "command", command: "node pre.js", timeout: 10 }] },
          ],
          SessionStart: [{ type: "command", command: "echo start", timeout: 5 }],
        },
      }),
      "utf-8",
    );

    const imported = await adapter.import(tmp);
    expect(imported.map((h) => h.name).toSorted()).toEqual(["echo start", "node pre.js"]);
    expect(imported.find((h) => h.name === "echo start")?.events).toEqual(["session:start"]);
    expect(imported.find((h) => h.name === "node pre.js")?.events).toContain("shell:before");

    await mkdir(join(home, ".gemini/config"), { recursive: true });
    await writeFile(
      join(home, ".gemini/config/hooks.json"),
      JSON.stringify({
        personal: {
          Stop: [{ type: "command", command: "echo bye", timeout: 5 }],
        },
      }),
      "utf-8",
    );

    const userImported = await adapter.importUser();
    expect(userImported).toHaveLength(1);
    expect(userImported[0]?.name).toBe("echo bye");
    expect(userImported[0]?.events).toEqual(["session:end"]);
    expect(userImported[0]?.phase).toBe("after");
  });

  it("detects agy command, workspace .agents, user hooks, and settings.json", async () => {
    expect(await adapter.detect()).toBe(false);

    await mkdir(join(home, ".gemini/antigravity-cli"), { recursive: true });
    await writeFile(join(home, ".gemini/antigravity-cli/settings.json"), "{}\n", "utf-8");
    expect(await adapter.detect()).toBe(true);

    await rm(join(home, ".gemini"), { recursive: true, force: true });
    await mkdir(join(tmp, ".agents"), { recursive: true });
    expect(await adapter.detect()).toBe(true);

    await rm(join(tmp, ".agents"), { recursive: true, force: true });
    vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof execFile);
    expect(await adapter.detect()).toBe(true);
  });
});
