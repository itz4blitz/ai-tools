import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { addManagedBlock, removeManagedBlock, hasManagedBlock } from "./gitignore.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── addManagedBlock ─────────────────────────────────────────

describe("addManagedBlock", () => {
  it("creates .gitignore with managed block when file does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    await addManagedBlock();
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining(".gitignore"),
      expect.stringContaining("ai-tools managed"),
      "utf-8",
    );
    await addManagedBlock("/test");
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining(".gitignore"),
      expect.stringContaining("ai-tools managed"),
      "utf-8",
    );
    const written = mockWriteFile.mock.calls[0]?.[1] as string;
    expect(written).toContain(".claude/");
    expect(written).toContain(".cursor/");
    expect(written).toContain(".clinerules/");
    expect(written).toContain(".grok/");
    expect(written).toContain(".zcode/");
    expect(written).toContain(".roomodes");
    expect(written).toContain(".windsurf/");
    expect(written).toContain("end ai-tools managed");
  });

  it("appends managed block to existing .gitignore", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("node_modules/\n");
    await addManagedBlock("/test");
    const written = mockWriteFile.mock.calls[0]?.[1] as string;
    expect(written).toContain("node_modules/");
    expect(written).toContain("ai-tools managed");
  });

  it("does not duplicate managed block", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(
      "# ── ai-tools managed (canonical mode) ──\n.claude/\n# ── end ai-tools managed ──\n",
    );
    await addManagedBlock("/test");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("handles existing content without trailing newline", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("node_modules/");
    await addManagedBlock("/test");
    const written = mockWriteFile.mock.calls[0]?.[1] as string;
    expect(written).toContain("node_modules/");
    expect(written).toContain("ai-tools managed");
  });
});

// ── removeManagedBlock ──────────────────────────────────────

describe("removeManagedBlock", () => {
  it("does nothing when .gitignore does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    await removeManagedBlock("/test");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("does nothing when block is not present", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("node_modules/\n");
    await removeManagedBlock("/test");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("removes managed block and cleans up whitespace", async () => {
    const content =
      "node_modules/\n\n# ── ai-tools managed (canonical mode) ──\n.claude/\n# ── end ai-tools managed ──\n";
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(content);
    await removeManagedBlock("/test");
    const written = mockWriteFile.mock.calls[0]?.[1] as string;
    expect(written).toContain("node_modules/");
    expect(written).not.toContain("ai-tools managed");
  });

  it("does nothing when the start marker is present without the end marker", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("# ── ai-tools managed (canonical mode) ──\n.claude/\n");
    await removeManagedBlock("/test");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("handles file with only managed block", async () => {
    const content =
      "# ── ai-tools managed (canonical mode) ──\n.claude/\n# ── end ai-tools managed ──\n";
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(content);
    await removeManagedBlock("/test");
    const written = mockWriteFile.mock.calls[0]?.[1] as string;
    expect(written).toBe("");
  });
});

// ── hasManagedBlock ─────────────────────────────────────────

describe("hasManagedBlock", () => {
  it("returns false when .gitignore does not exist", async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await hasManagedBlock("/test");
    expect(result).toBe(false);
  });

  it("returns false when block is not present", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("node_modules/\n");
    const result = await hasManagedBlock("/test");
    expect(result).toBe(false);
  });

  it("returns true when block is present", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(
      "# ── ai-tools managed (canonical mode) ──\n.claude/\n# ── end ai-tools managed ──\n",
    );
    const result = await hasManagedBlock();
    expect(result).toBe(true);
  });
});
