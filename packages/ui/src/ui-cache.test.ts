import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const existsSync = vi.fn();
const mkdir = vi.fn();
const readFile = vi.fn();
const writeFile = vi.fn();

vi.mock("node:fs", () => ({
  existsSync,
}));

vi.mock("node:fs/promises", () => ({
  mkdir,
  readFile,
  writeFile,
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/testuser",
}));

const data = {
  tools: [{ id: "codex", name: "Codex", detected: true, status: "available" }],
  sessions: [],
  engines: [{ engine: "skills", status: "configured", details: "ready" }],
  mode: "tools",
  configHealth: "healthy",
  sessionCount: 0,
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    updatedAt: "2026-06-02T14:00:00.000Z",
    cwd: "/repo",
    slices: {
      tools: "2026-06-02T14:00:00.000Z",
      sessions: "2026-06-02T14:00:00.000Z",
      config: "2026-06-02T14:00:00.000Z",
    },
    data,
    ...overrides,
  };
}

describe("ui-cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-02T14:00:10.000Z"));
  });

  it("returns null when no cache file exists", async () => {
    existsSync.mockReturnValue(false);
    const { readUiCache } = await import("./ui-cache.js");

    await expect(readUiCache("/repo")).resolves.toBeNull();
  });

  it("returns null for invalid cache payloads", async () => {
    existsSync.mockReturnValue(true);
    readFile.mockResolvedValue(JSON.stringify(record({ version: 0 })));
    const { readUiCache } = await import("./ui-cache.js");

    await expect(readUiCache("/repo")).resolves.toBeNull();

    readFile.mockResolvedValue("not json");
    await expect(readUiCache("/repo")).resolves.toBeNull();
  });

  it("returns fresh slice state for valid records", async () => {
    existsSync.mockReturnValue(true);
    readFile.mockResolvedValue(JSON.stringify(record()));
    const { readUiCache } = await import("./ui-cache.js");

    const snapshot = await readUiCache("/repo", {
      toolsMs: 45_000,
      sessionsMs: 20_000,
      configMs: 60_000,
    });

    expect(snapshot).toMatchObject({
      data,
      updatedAt: "2026-06-02T14:00:00.000Z",
      ageMs: 10_000,
      fresh: true,
      freshBySlice: { tools: true, sessions: true, config: true },
    });
  });

  it("marks stale slices without rejecting the cache", async () => {
    existsSync.mockReturnValue(true);
    readFile.mockResolvedValue(
      JSON.stringify(
        record({
          slices: {
            tools: "2026-06-02T13:59:00.000Z",
            sessions: "2026-06-02T14:00:00.000Z",
            config: "2026-06-02T13:59:00.000Z",
          },
        }),
      ),
    );
    const { readUiCache } = await import("./ui-cache.js");

    const snapshot = await readUiCache("/repo", {
      toolsMs: 45_000,
      sessionsMs: 20_000,
      configMs: 60_000,
    });

    expect(snapshot?.fresh).toBe(false);
    expect(snapshot?.freshBySlice).toEqual({ tools: false, sessions: true, config: false });
  });

  it("writes normalized cache records", async () => {
    const { writeUiCache } = await import("./ui-cache.js");

    await writeUiCache("/repo/../repo", data, {
      tools: "2026-06-02T13:59:59.000Z",
    });

    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining(join(".ai-tools", "ui-cache")), {
      recursive: true,
    });
    const written = JSON.parse(writeFile.mock.calls[0]![1] as string);
    expect(written).toMatchObject({
      version: 1,
      cwd: resolve("/repo"),
      data,
      slices: {
        tools: "2026-06-02T13:59:59.000Z",
        sessions: "2026-06-02T14:00:10.000Z",
        config: "2026-06-02T14:00:10.000Z",
      },
    });
  });
});
