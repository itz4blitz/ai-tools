import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookContext, HookDefinition, HookEventType } from "../index.js";

const mockHome = vi.hoisted(() => ({ dir: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockHome.dir || actual.homedir(),
  };
});

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
import { GrokAdapter } from "./grok.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

const shellHook: HookDefinition = {
  id: "audit",
  name: "audit",
  events: ["shell:before" as HookEventType],
  phase: "before",
  handler: makeHandler(),
};

describe("GrokAdapter", () => {
  let adapter: GrokAdapter;
  let tmp: string;
  let fakeHome: string;
  let previousCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new GrokAdapter();
    tmp = await mkdtemp(join(tmpdir(), "grok hooks-"));
    fakeHome = await mkdtemp(join(tmpdir(), "grok-home-"));
    mockHome.dir = fakeHome;
    previousCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    mockHome.dir = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("uses Grok identity, Stop/prompt:response mapping, and file blockable events", () => {
    expect(adapter.id).toBe("grok");
    expect(adapter.name).toBe("Grok");
    expect(adapter.mapEvent("tool:before")).toEqual(["PreToolUse"]);
    expect(adapter.mapEvent("session:end")).toEqual(["SessionEnd"]);
    expect(adapter.mapEvent("prompt:response")).toEqual(["Stop"]);
    expect(adapter.mapNativeEvent("SessionStart")).toEqual(["session:start"]);
    expect(adapter.mapNativeEvent("Stop")).toEqual(["prompt:response"]);
    expect(adapter.capabilities.supportedEvents).toContain("prompt:response");
    expect(adapter.capabilities.blockableEvents).toEqual(
      expect.arrayContaining([
        "prompt:submit",
        "tool:before",
        "file:read",
        "file:write",
        "file:edit",
        "file:delete",
        "shell:before",
        "mcp:before",
      ]),
    );
  });

  it("writes .grok/hooks JSON with repo-root runner command and import.meta.url PROJECT_ROOT", async () => {
    const files = await adapter.generate([shellHook]);
    await adapter.install(files);

    expect(files.map((file) => file.path)).toEqual([
      ".grok/hooks/ai-tools.json",
      ".grok/hooks/ai-tools-runner.js",
    ]);

    const jsonPath = join(tmp, ".grok/hooks/ai-tools.json");
    const runnerPath = join(tmp, ".grok/hooks/ai-tools-runner.js");
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(runnerPath)).toBe(true);

    const parsedJson = JSON.parse(await readFile(jsonPath, "utf-8")) as {
      hooks: Record<
        string,
        Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>
      >;
    };
    expect(parsedJson).toEqual({
      hooks: {
        PreToolUse: [
          {
            hooks: [
              {
                type: "command",
                command: 'node ".grok/hooks/ai-tools-runner.js"',
                timeout: 10,
              },
            ],
          },
        ],
      },
    });

    // Verify the relative path referenced by RUNNER_COMMAND exists from repo root
    const command = parsedJson.hooks.PreToolUse?.[0]?.hooks?.[0]?.command ?? "";
    const scriptRelPath = command.match(/^node "(.+)"$/)?.[1];
    expect(scriptRelPath).toBe(".grok/hooks/ai-tools-runner.js");
    expect(existsSync(join(tmp, scriptRelPath!))).toBe(true);

    const runner = await readFile(runnerPath, "utf-8");
    expect(runner.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(runner).toContain('import { dirname, resolve } from "node:path"');
    expect(runner).toContain('import { fileURLToPath } from "node:url"');
    expect(runner).toContain(
      'const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");',
    );
    expect(runner).not.toContain(tmp);
    expect(runner).toContain('import { runGrokHook } from "@itz4blitz/ai-tools-hooks"');
    expect(runner).toContain("process.exit(await runGrokHook())");
  });

  it("maps multiple universal events including prompt:response onto Grok native names without duplicates", async () => {
    const files = await adapter.generate([
      {
        id: "multi",
        name: "multi",
        events: ["session:start", "prompt:response", "shell:before", "file:write", "notification"],
        phase: "before",
        handler: makeHandler(),
      },
    ]);
    const json = JSON.parse(files[0]!.content) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(json.hooks).toSorted()).toEqual([
      "Notification",
      "PreToolUse",
      "SessionStart",
      "Stop",
    ]);
    expect(json.hooks.PreToolUse).toHaveLength(1);
  });

  it("detects a project .grok directory with explicit cwd", async () => {
    const otherDir = await mkdtemp(join(tmpdir(), "grok-other-"));
    try {
      expect(await adapter.detect(otherDir)).toBe(false);
      await mkdir(join(otherDir, ".grok"));
      expect(await adapter.detect(otherDir)).toBe(true);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("detects a user ~/.grok directory even without project .grok or binary", async () => {
    expect(await adapter.detect(tmp)).toBe(false);
    await mkdir(join(fakeHome, ".grok"));
    expect(await adapter.detect(tmp)).toBe(true);
  });

  it("detects the grok command when present", async () => {
    vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof execFile);
    expect(await adapter.detect()).toBe(true);
  });

  it("imports and disambiguates hook IDs across multiple .grok/hooks/*.json files", async () => {
    await mkdir(join(tmp, ".grok/hooks"), { recursive: true });
    await writeFile(
      join(tmp, ".grok/hooks/alpha.json"),
      `${JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "/usr/bin/alpha-check", timeout: 5 }],
            },
          ],
        },
      })}\n`,
      "utf-8",
    );
    await writeFile(
      join(tmp, ".grok/hooks/beta.json"),
      `${JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Write",
              hooks: [{ type: "command", command: "/usr/bin/beta-check", timeout: 5 }],
            },
          ],
          Stop: [
            {
              hooks: [{ type: "command", command: "/usr/bin/on-stop", timeout: 5 }],
            },
          ],
        },
      })}\n`,
      "utf-8",
    );

    const imported = await adapter.import(tmp);
    expect(imported).toHaveLength(3);
    expect(imported.map((h) => h.id)).toEqual([
      "grok-alpha-PreToolUse-0-0",
      "grok-beta-PreToolUse-0-0",
      "grok-beta-Stop-0-0",
    ]);
    expect(imported[0]?.name).toBe("/usr/bin/alpha-check");
    expect(imported[0]?.events).toContain("shell:before");
    expect(imported[0]?.phase).toBe("before");
    expect(imported[2]?.events).toEqual(["prompt:response"]);
    expect(imported[2]?.phase).toBe("after");
  });

  it("skips invalid JSON while importing Grok hooks", async () => {
    await mkdir(join(tmp, ".grok/hooks"), { recursive: true });
    await writeFile(join(tmp, ".grok/hooks/broken.json"), "{not json", "utf-8");
    await writeFile(join(tmp, ".grok/hooks/notes.txt"), "ignore me", "utf-8");
    await writeFile(join(tmp, ".grok/hooks/empty.json"), "{}\n", "utf-8");
    expect(await adapter.import(tmp)).toEqual([]);
  });

  it("imports from process.cwd when no directory is passed", async () => {
    expect(await adapter.import()).toEqual([]);
    expect(adapter.mapEvent("unknown:event" as HookEventType)).toEqual([]);
    expect(adapter.mapNativeEvent("NotAThing")).toEqual([]);
  });

  it("uninstalls generated hook files from the project", async () => {
    await adapter.install(await adapter.generate([shellHook]));
    expect(existsSync(join(tmp, ".grok/hooks/ai-tools.json"))).toBe(true);
    await adapter.uninstall();
    expect(existsSync(join(tmp, ".grok/hooks/ai-tools.json"))).toBe(false);
    expect(existsSync(join(tmp, ".grok/hooks/ai-tools-runner.js"))).toBe(false);
  });
});
