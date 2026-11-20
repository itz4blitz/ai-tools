import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
}));

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CanonicalStore } from "./canonical.js";
import type { AgentDefinition } from "../types/index.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);
const mockReaddir = vi.mocked(readdir);
const mockRm = vi.mocked(rm);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const agent: AgentDefinition = {
  id: "coder",
  name: "Coder Agent",
  instructions: "Write code.",
};

// ── write ───────────────────────────────────────────────────

describe("CanonicalStore.write", () => {
  it("creates directory and writes each item as JSON", async () => {
    const store = new CanonicalStore("/test");
    const paths = await store.write([agent]);

    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining(join(".ai-tools", "agents")), {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("coder.json"),
      JSON.stringify(agent, null, 2) + "\n",
      "utf-8",
    );
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("coder.json");
  });

  it("writes multiple items", async () => {
    const store = new CanonicalStore("/test");
    const items: AgentDefinition[] = [
      agent,
      { id: "reviewer", name: "Reviewer", instructions: "Review." },
    ];
    const paths = await store.write(items);
    expect(mockWriteFile).toHaveBeenCalledTimes(2);
    expect(paths).toHaveLength(2);
  });
});

// ── read ────────────────────────────────────────────────────

describe("CanonicalStore.read", () => {
  it("returns null when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const store = new CanonicalStore("/test");
    const result = await store.read("coder");
    expect(result).toBeNull();
  });

  it("reads and parses JSON file", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify(agent));
    const store = new CanonicalStore("/test");
    const result = await store.read("coder");
    expect(result).toEqual(agent);
  });
});

// ── list ────────────────────────────────────────────────────

describe("CanonicalStore.list", () => {
  it("returns empty array when directory does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const store = new CanonicalStore("/test");
    const result = await store.list();
    expect(result).toEqual([]);
  });

  it("returns IDs from JSON files", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue(["coder.json", "reviewer.json"] as unknown as Awaited<
      ReturnType<typeof readdir>
    >);
    const store = new CanonicalStore("/test");
    const result = await store.list();
    expect(result).toEqual(["coder", "reviewer"]);
  });
});

// ── clean ───────────────────────────────────────────────────

describe("CanonicalStore.clean", () => {
  it("returns false when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const store = new CanonicalStore("/test");
    const result = await store.clean("coder");
    expect(result).toBe(false);
    expect(mockRm).not.toHaveBeenCalled();
  });

  it("removes file and returns true", async () => {
    mockExistsSync.mockReturnValue(true);
    const store = new CanonicalStore("/test");
    const result = await store.clean("coder");
    expect(result).toBe(true);
    expect(mockRm).toHaveBeenCalledWith(expect.stringContaining("coder.json"));
  });
});

// ── cleanAll ────────────────────────────────────────────────

describe("CanonicalStore.cleanAll", () => {
  it("removes all JSON files and returns count", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue(["coder.json", "reviewer.json"] as unknown as Awaited<
      ReturnType<typeof readdir>
    >);
    const store = new CanonicalStore("/test");
    const count = await store.cleanAll();
    expect(count).toBe(2);
    expect(mockRm).toHaveBeenCalledTimes(2);
  });

  it("returns 0 when directory is empty", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof readdir>>);
    const store = new CanonicalStore("/test");
    const count = await store.cleanAll();
    expect(count).toBe(0);
  });
});
