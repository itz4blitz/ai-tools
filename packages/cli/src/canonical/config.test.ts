import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readConfig, writeConfig, getMode, isCanonical } from "./config.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── readConfig ──────────────────────────────────────────────

describe("readConfig", () => {
  it("returns null when config file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await readConfig("/test");
    expect(result).toBeNull();
  });

  it("reads and parses config file", async () => {
    const config = { mode: "canonical", createdAt: "2026-01-01T00:00:00Z" };
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify(config));
    const result = await readConfig("/test");
    expect(result).toEqual(config);
  });

  it("uses process.cwd() when cwd is not provided", async () => {
    mockExistsSync.mockReturnValue(false);
    await readConfig();
    expect(mockExistsSync).toHaveBeenCalledWith(
      expect.stringContaining(join(".ai-tools", "config.json")),
    );
  });
});

// ── writeConfig ─────────────────────────────────────────────

describe("writeConfig", () => {
  it("creates directory and writes config", async () => {
    const config = { mode: "canonical" as const, createdAt: "2026-01-01T00:00:00Z" };
    await writeConfig(config, "/test");
    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining(".ai-tools"), {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining(join(".ai-tools", "config.json")),
      JSON.stringify(config, null, 2) + "\n",
      "utf-8",
    );
  });
});

// ── getMode ─────────────────────────────────────────────────

describe("getMode", () => {
  it("returns 'direct' when config does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const mode = await getMode("/test");
    expect(mode).toBe("direct");
  });

  it("returns mode from config", async () => {
    const config = { mode: "canonical", createdAt: "2026-01-01T00:00:00Z" };
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify(config));
    const mode = await getMode("/test");
    expect(mode).toBe("canonical");
  });
});

// ── isCanonical ─────────────────────────────────────────────

describe("isCanonical", () => {
  it("returns false when no config", async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await isCanonical("/test");
    expect(result).toBe(false);
  });

  it("returns true when mode is canonical", async () => {
    const config = { mode: "canonical", createdAt: "2026-01-01T00:00:00Z" };
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify(config));
    const result = await isCanonical("/test");
    expect(result).toBe(true);
  });

  it("returns false when mode is direct", async () => {
    const config = { mode: "direct", createdAt: "2026-01-01T00:00:00Z" };
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify(config));
    const result = await isCanonical("/test");
    expect(result).toBe(false);
  });
});
