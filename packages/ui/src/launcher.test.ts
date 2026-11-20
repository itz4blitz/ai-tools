import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  launchTool,
  buildLaunchOptions,
  buildHandoffLaunchOptions,
  type LaunchOptions,
  type SpawnFn,
} from "./launcher.js";

function createMockChild(pid: number): ChildProcess {
  const emitter = new EventEmitter();
  (emitter as unknown as Record<string, unknown>).pid = pid;
  (emitter as unknown as Record<string, unknown>).stdin = null;
  (emitter as unknown as Record<string, unknown>).stdout = null;
  (emitter as unknown as Record<string, unknown>).stderr = null;
  return emitter as unknown as ChildProcess;
}

function createMockSpawn(child: ChildProcess): SpawnFn {
  return vi.fn().mockReturnValue(child) as unknown as SpawnFn;
}

describe("launchTool", () => {
  it("spawns process with inherited stdio", async () => {
    const child = createMockChild(1234);
    const mockSpawn = createMockSpawn(child);

    const promise = launchTool({ command: "claude", args: [] }, mockSpawn);
    child.emit("close", 0);
    const result = await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      [],
      expect.objectContaining({
        stdio: "inherit",
        shell: process.platform === "win32",
      }),
    );
    expect(result.pid).toBe(1234);
    expect(result.exitCode).toBe(0);
  });

  it("resolves with exit code on close", async () => {
    const child = createMockChild(5678);
    const mockSpawn = createMockSpawn(child);

    const promise = launchTool({ command: "codex", args: ["--help"] }, mockSpawn);
    child.emit("close", 42);
    const result = await promise;

    expect(result.exitCode).toBe(42);
  });

  it("defaults exit code to 1 when null", async () => {
    const child = createMockChild(100);
    const mockSpawn = createMockSpawn(child);

    const promise = launchTool({ command: "gemini", args: [] }, mockSpawn);
    child.emit("close", null);
    const result = await promise;

    expect(result.exitCode).toBe(1);
  });

  it("rejects on spawn error", async () => {
    const child = createMockChild(0);
    const mockSpawn = createMockSpawn(child);

    const promise = launchTool({ command: "nonexistent", args: [] }, mockSpawn);
    child.emit("error", new Error("ENOENT"));

    await expect(promise).rejects.toThrow("ENOENT");
  });

  it("uses custom cwd when provided", async () => {
    const child = createMockChild(1);
    const mockSpawn = createMockSpawn(child);

    const promise = launchTool({ command: "claude", args: [], cwd: "/custom/path" }, mockSpawn);
    child.emit("close", 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      [],
      expect.objectContaining({
        cwd: "/custom/path",
      }),
    );
  });

  it("passes args to spawned process", async () => {
    const child = createMockChild(1);
    const mockSpawn = createMockSpawn(child);

    const promise = launchTool({ command: "claude", args: ["--prompt", "hello world"] }, mockSpawn);
    child.emit("close", 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["--prompt", "hello world"],
      expect.any(Object),
    );
  });

  it("defaults pid to 0 when undefined", async () => {
    const emitter = new EventEmitter();
    (emitter as unknown as Record<string, unknown>).pid = undefined;
    (emitter as unknown as Record<string, unknown>).stdin = null;
    (emitter as unknown as Record<string, unknown>).stdout = null;
    (emitter as unknown as Record<string, unknown>).stderr = null;
    const child = emitter as unknown as ChildProcess;
    const mockSpawn = createMockSpawn(child);

    const promise = launchTool({ command: "test", args: [] }, mockSpawn);
    child.emit("close", 0);
    const result = await promise;

    expect(result.pid).toBe(0);
  });
});

describe("buildLaunchOptions", () => {
  it("returns launch options for known tool", () => {
    const result = buildLaunchOptions("claude", []);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("claude");
    expect(result!.args).toEqual([]);
  });

  it("returns null for unknown tool", () => {
    const result = buildLaunchOptions("unknown-tool", []);
    expect(result).toBeNull();
  });

  it("returns null when tool pane already exists (focus action)", () => {
    const result = buildLaunchOptions("claude", [{ toolId: "claude", active: true }]);
    expect(result).toBeNull();
  });

  it("includes args for tools with args", () => {
    const result = buildLaunchOptions("copilot", []);
    expect(result).not.toBeNull();
    expect(result!.command).toBe("gh");
    expect(result!.args).toEqual(["copilot"]);
  });
});

describe("buildHandoffLaunchOptions", () => {
  it("builds options from command and args", () => {
    const result = buildHandoffLaunchOptions("claude", ["--prompt", "context here"]);
    expect(result.command).toBe("claude");
    expect(result.args).toEqual(["--prompt", "context here"]);
  });

  it("builds options with empty args", () => {
    const result = buildHandoffLaunchOptions("gemini", []);
    expect(result.command).toBe("gemini");
    expect(result.args).toEqual([]);
  });
});
