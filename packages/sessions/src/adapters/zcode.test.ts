import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockHome } = vi.hoisted(() => ({ mockHome: { value: "" } }));

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

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
import { ZcodeSessionAdapter } from "./zcode.js";

describe("ZcodeSessionAdapter", () => {
  let adapter: ZcodeSessionAdapter;
  let tmp: string;
  let home: string;
  let previousCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "zcode-sessions-"));
    home = await mkdtemp(join(tmpdir(), "zcode-sessions-home-"));
    mockHome.value = home;
    adapter = new ZcodeSessionAdapter();
    previousCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("exposes expected metadata and storagePaths", () => {
    expect(adapter.id).toBe("zcode");
    expect(adapter.name).toBe("ZCode");
    expect(adapter.command).toBe("zcode");
    expect(adapter.storagePaths).toEqual([".zcode/sessions", "~/.zcode/sessions"]);
  });

  it("detects workspace sessions dir, ~/.zcode, and zcode binary", async () => {
    expect(await adapter.detect()).toBe(false);

    await mkdir(join(home, ".zcode"), { recursive: true });
    expect(await adapter.detect()).toBe(true);

    await rm(join(home, ".zcode"), { recursive: true, force: true });
    await mkdir(join(tmp, ".zcode", "sessions"), { recursive: true });
    expect(await adapter.detect()).toBe(true);

    await rm(join(tmp, ".zcode"), { recursive: true, force: true });
    vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof execFile);
    expect(await adapter.detect()).toBe(true);
  });

  it("returns empty array when no session directories exist", async () => {
    expect(await adapter.parseSessions()).toEqual([]);
  });

  it("scans workspace .zcode/sessions and ~/.zcode/sessions and skips malformed files", async () => {
    await mkdir(join(tmp, ".zcode", "sessions"), { recursive: true });
    await mkdir(join(home, ".zcode", "sessions"), { recursive: true });

    await writeFile(
      join(tmp, ".zcode", "sessions", "workspace-1.jsonl"),
      [
        JSON.stringify({ role: "user", content: "Refactor ZCode adapter" }),
        JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "Updating packages/mcp/src/adapters/zcode.ts now." }],
        }),
        "{broken-line",
        JSON.stringify({ role: "unknown", content: "skip me" }),
      ].join("\n"),
      "utf-8",
    );

    await writeFile(
      join(home, ".zcode", "sessions", "global-1.json"),
      JSON.stringify({
        id: "zcode-global-1",
        title: "Global ZCode session",
        cwd: "/workspace/demo",
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T01:00:00.000Z",
        messages: [
          { type: "human", text: "Check tests" },
          { role: "assistant", content: "All tests pass." },
        ],
      }),
      "utf-8",
    );

    await writeFile(join(home, ".zcode", "sessions", "corrupt.json"), "{not-valid", "utf-8");
    await writeFile(join(home, ".zcode", "sessions", "notes.txt"), "ignore me", "utf-8");

    const sessions = await adapter.parseSessions();
    expect(sessions).toHaveLength(2);

    const ws = sessions.find((s) => s.id === "zcode-workspace-1");
    expect(ws).toBeDefined();
    expect(ws?.tool).toBe("zcode");
    expect(ws?.toolName).toBe("ZCode");
    expect(ws?.title).toBe("Refactor ZCode adapter");
    expect(ws?.messageCount).toBe(2);
    expect(ws?.messages[1]?.content).toBe("Updating packages/mcp/src/adapters/zcode.ts now.");

    const globalSession = sessions.find((s) => s.id === "zcode-global-1");
    expect(globalSession).toBeDefined();
    expect(globalSession?.title).toBe("Global ZCode session");
    expect(globalSession?.projectPath).toBe("/workspace/demo");
    expect(globalSession?.messages).toHaveLength(2);
    expect(globalSession?.messages[0]?.role).toBe("user");

    const filtered = await adapter.parseSessions({ projectPath: "/workspace/demo" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe("zcode-global-1");

    const limited = await adapter.parseSessions({ limit: 1 });
    expect(limited).toHaveLength(1);
  });
});
