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
import type { MCPServerDefinition } from "../types/index.js";

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

const server: MCPServerDefinition = {
  id: "my-server",
  name: "My Server",
  transport: { type: "stdio", command: "node", args: ["server.js"] },
};

// ── write ───────────────────────────────────────────────────

describe("CanonicalStore.write", () => {
  it("creates directory and writes servers.json", async () => {
    const store = new CanonicalStore("/test");
    const paths = await store.write([server]);

    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining(join(".ai-tools", "mcp")), {
      recursive: true,
    });
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("servers.json"),
      JSON.stringify([server], null, 2) + "\n",
      "utf-8",
    );
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("servers.json");
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

  it("reads and parses servers.json", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify([server]));
    const store = new CanonicalStore("/test");
    const result = await store.read();
    expect(result).toEqual([server]);
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

  it("returns ['servers'] when file exists", async () => {
    mockExistsSync.mockReturnValue(true);
    const store = new CanonicalStore("/test");
    const result = await store.list();
    expect(result).toEqual(["servers"]);
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
    expect(mockRm).toHaveBeenCalledWith(expect.stringContaining("servers.json"));
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
