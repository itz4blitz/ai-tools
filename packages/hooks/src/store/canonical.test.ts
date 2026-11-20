import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CanonicalStore } from "./canonical.js";
import type { HookDefinition } from "../types/index.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);
const mockRm = vi.mocked(rm);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const hook: HookDefinition = {
  id: "block-rm",
  name: "Block rm -rf",
  events: ["shell:before"],
  phase: "before",
  handler: async () => {},
};

// ── write ───────────────────────────────────────────────────

describe("CanonicalStore.write", () => {
  it("creates directory and writes hooks.json with serialized definitions", async () => {
    const store = new CanonicalStore("/test");
    const paths = await store.write([hook]);

    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining(join(".ai-tools", "hooks")), {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("hooks.json"),
      expect.stringContaining("block-rm"),
      "utf-8",
    );

    // Verify handler is stripped from serialized output
    const written = mockWriteFile.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written) as unknown[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).not.toHaveProperty("handler");
    expect(parsed[0]).not.toHaveProperty("filter");

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("hooks.json");
  });
});

// ── read ────────────────────────────────────────────────────

describe("CanonicalStore.read", () => {
  it("returns empty array when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const store = new CanonicalStore("/test");
    const result = await store.read();
    expect(result).toEqual([]);
  });

  it("reads and parses hooks.json", async () => {
    const serialized = [
      { id: "block-rm", name: "Block rm -rf", events: ["shell:before"], phase: "before" },
    ];
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify(serialized));
    const store = new CanonicalStore("/test");
    const result = await store.read();
    expect(result).toEqual(serialized);
  });
});

// ── list ────────────────────────────────────────────────────

describe("CanonicalStore.list", () => {
  it("returns empty array when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const store = new CanonicalStore("/test");
    const result = await store.list();
    expect(result).toEqual([]);
  });

  it("returns ['hooks'] when file exists", async () => {
    mockExistsSync.mockReturnValue(true);
    const store = new CanonicalStore("/test");
    const result = await store.list();
    expect(result).toEqual(["hooks"]);
  });
});

// ── clean ───────────────────────────────────────────────────

describe("CanonicalStore.clean", () => {
  it("returns false when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const store = new CanonicalStore("/test");
    const result = await store.clean();
    expect(result).toBe(false);
    expect(mockRm).not.toHaveBeenCalled();
  });

  it("removes file and returns true", async () => {
    mockExistsSync.mockReturnValue(true);
    const store = new CanonicalStore("/test");
    const result = await store.clean();
    expect(result).toBe(true);
    expect(mockRm).toHaveBeenCalledWith(expect.stringContaining("hooks.json"));
  });
});

// ── cleanAll ────────────────────────────────────────────────

describe("CanonicalStore.cleanAll", () => {
  it("returns 1 when file exists and is removed", async () => {
    mockExistsSync.mockReturnValue(true);
    const store = new CanonicalStore("/test");
    const count = await store.cleanAll();
    expect(count).toBe(1);
  });

  it("returns 0 when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const store = new CanonicalStore("/test");
    const count = await store.cleanAll();
    expect(count).toBe(0);
  });
});
