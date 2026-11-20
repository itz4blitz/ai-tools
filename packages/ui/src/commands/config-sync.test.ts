import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readdirSync: vi.fn().mockReturnValue([]),
}));

vi.mock("node:path", () => ({
  resolve: (...args: string[]) => args.join("/"),
}));

import { triggerGenerate, triggerInstall, triggerSync, getCanonicalStatus } from "./config-sync.js";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

beforeEach(() => {
  vi.clearAllMocks();
});

// -- triggerGenerate --

describe("triggerGenerate()", () => {
  it("calls npx ai-tools generate", async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        void cmd;
        void args;
        void opts;
        cb(null, "Generated successfully", "");
      },
    );

    const result = await triggerGenerate();
    expect(result).toBe("Generated successfully");
    expect(execFile).toHaveBeenCalledWith(
      "npx",
      ["ai-tools", "generate"],
      expect.objectContaining({ cwd: process.cwd(), shell: process.platform === "win32" }),
      expect.any(Function),
    );
  });

  it("rejects on error", async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        void cmd;
        void args;
        void opts;
        cb(new Error("command failed"), "", "Something went wrong");
      },
    );

    await expect(triggerGenerate()).rejects.toThrow("Something went wrong");
  });

  it("rejects with error message when stderr is empty", async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        void cmd;
        void args;
        void opts;
        cb(new Error("command failed"), "", "");
      },
    );

    await expect(triggerGenerate()).rejects.toThrow("command failed");
  });
});

// -- triggerInstall --

describe("triggerInstall()", () => {
  it("calls npx ai-tools install", async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        void cmd;
        void args;
        void opts;
        cb(null, "Installed successfully", "");
      },
    );

    const result = await triggerInstall();
    expect(result).toBe("Installed successfully");
    expect(execFile).toHaveBeenCalledWith(
      "npx",
      ["ai-tools", "install"],
      expect.objectContaining({ cwd: process.cwd() }),
      expect.any(Function),
    );
  });

  it("rejects on error", async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        void cmd;
        void args;
        void opts;
        cb(new Error("install failed"), "", "Install error");
      },
    );

    await expect(triggerInstall()).rejects.toThrow("Install error");
  });
});

// -- triggerSync --

describe("triggerSync()", () => {
  it("calls npx ai-tools mcp sync, not union sync or empty install", async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        void cmd;
        void args;
        void opts;
        cb(null, "Sync complete!", "");
      },
    );

    const result = await triggerSync();
    expect(result).toBe("Sync complete!");
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      "npx",
      ["ai-tools", "mcp", "sync"],
      expect.objectContaining({ cwd: process.cwd() }),
      expect.any(Function),
    );
    expect(execFile).not.toHaveBeenCalledWith(
      "npx",
      ["ai-tools", "sync"],
      expect.anything(),
      expect.any(Function),
    );
    expect(execFile).not.toHaveBeenCalledWith(
      "npx",
      ["ai-tools", "mcp", "install"],
      expect.anything(),
      expect.any(Function),
    );
  });

  it("rejects on error with stderr", async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        void cmd;
        void args;
        void opts;
        cb(new Error("sync failed"), "", "MCP install error");
      },
    );

    await expect(triggerSync()).rejects.toThrow("MCP install error");
  });

  it("rejects with error message when stderr is empty", async () => {
    (execFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (
        cmd: string,
        args: string[],
        opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        void cmd;
        void args;
        void opts;
        cb(new Error("command failed"), "", "");
      },
    );

    await expect(triggerSync()).rejects.toThrow("command failed");
  });
});

// -- getCanonicalStatus --

describe("getCanonicalStatus()", () => {
  it("returns exists: false when directory does not exist", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const status = await getCanonicalStatus();
    expect(status.exists).toBe(false);
    expect(status.engineCount).toBe(0);
  });

  it("returns exists: true and counts config files", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
      "hooks.json",
      "mcp.json",
      "README.md",
    ]);

    const status = await getCanonicalStatus();
    expect(status.exists).toBe(true);
    expect(status.engineCount).toBe(2);
  });

  it("counts .ts and .js config files too", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
      "hooks.json",
      "config.ts",
      "setup.js",
      "notes.txt",
    ]);

    const status = await getCanonicalStatus();
    expect(status.engineCount).toBe(3);
  });

  it("handles readdirSync error gracefully", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("permission denied");
    });

    const status = await getCanonicalStatus();
    expect(status.exists).toBe(true);
    expect(status.engineCount).toBe(0);
  });

  it("excludes config.json and manifest.json from engineCount", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
      "config.json",
      "manifest.json",
      "hooks.json",
      "mcp.json",
    ]);

    const status = await getCanonicalStatus();
    expect(status.exists).toBe(true);
    expect(status.engineCount).toBe(2);
  });

  it("includes the path in result", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const status = await getCanonicalStatus();
    expect(status.path).toContain(".ai-tools");
  });
});
