import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config/manifest/gitignore modules
vi.mock("./config.js", () => ({
  writeConfig: vi.fn(),
  isCanonical: vi.fn(),
  getMode: vi.fn(),
}));

vi.mock("./manifest.js", () => ({
  readManifest: vi.fn(),
  writeManifest: vi.fn(),
}));

vi.mock("./gitignore.js", () => ({
  addManagedBlock: vi.fn(),
  removeManagedBlock: vi.fn(),
  hasManagedBlock: vi.fn(),
}));

// Mock engine CLIs
const mockHooksRun = vi.fn();
const mockMcpRun = vi.fn();
const mockSkillsRun = vi.fn();
const mockAgentsRun = vi.fn();
const mockRulesRun = vi.fn();

vi.mock("@itz4blitz/ai-tools-hooks/cli", () => ({ run: mockHooksRun }));
vi.mock("@itz4blitz/ai-tools-mcp/cli", () => ({ run: mockMcpRun }));
vi.mock("@itz4blitz/ai-tools-skills/cli", () => ({ run: mockSkillsRun }));
vi.mock("@itz4blitz/ai-tools-agents/cli", () => ({ run: mockAgentsRun }));
vi.mock("@itz4blitz/ai-tools-rules/cli", () => ({ run: mockRulesRun }));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  rm: vi.fn(),
}));

import { writeConfig, isCanonical, getMode } from "./config.js";
import { readManifest, writeManifest } from "./manifest.js";
import { addManagedBlock, removeManagedBlock, hasManagedBlock } from "./gitignore.js";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { cmdInit, cmdGenerate, cmdInstall, cmdStatus, cmdClean } from "./commands.js";
import * as canonical from "./index.js";

const mockWriteConfig = vi.mocked(writeConfig);
const mockIsCanonical = vi.mocked(isCanonical);
const mockGetMode = vi.mocked(getMode);
const mockReadManifest = vi.mocked(readManifest);
const mockWriteManifest = vi.mocked(writeManifest);
const mockAddManagedBlock = vi.mocked(addManagedBlock);
const mockRemoveManagedBlock = vi.mocked(removeManagedBlock);
const mockHasManagedBlock = vi.mocked(hasManagedBlock);
const mockExistsSync = vi.mocked(existsSync);
const mockRm = vi.mocked(rm);

let logOutput: string[];
let errorOutput: string[];

const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  logOutput = [];
  errorOutput = [];

  console.log = vi.fn((...args: unknown[]) => {
    logOutput.push(args.map(String).join(" "));
  });
  console.error = vi.fn((...args: unknown[]) => {
    errorOutput.push(args.map(String).join(" "));
  });

  vi.clearAllMocks();
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

function allLog(): string {
  return logOutput.join("\n");
}

function allError(): string {
  return errorOutput.join("\n");
}

// ── cmdInit ─────────────────────────────────────────────────

describe("canonical barrel", () => {
  it("re-exports config helpers used by the CLI", () => {
    expect(canonical.writeConfig).toBe(writeConfig);
    expect(canonical.readManifest).toBe(readManifest);
    expect(canonical.addManagedBlock).toBe(addManagedBlock);
  });
});

describe("cmdInit", () => {
  it("creates config and adds gitignore block", async () => {
    mockGetMode.mockResolvedValue("direct");
    await cmdInit([]);
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.objectContaining({ mode: "canonical" }));
    expect(mockAddManagedBlock).toHaveBeenCalled();
    expect(allLog()).toContain("Initialized");
  });

  it("does not reinitialize when already canonical", async () => {
    mockGetMode.mockResolvedValue("canonical");
    await cmdInit([]);
    expect(mockWriteConfig).not.toHaveBeenCalled();
    expect(allLog()).toContain("Already initialized");
  });

  it("respects --dry-run flag", async () => {
    mockGetMode.mockResolvedValue("direct");
    await cmdInit(["--dry-run"]);
    expect(mockWriteConfig).not.toHaveBeenCalled();
    expect(allLog()).toContain("[dry-run]");
  });
});

// ── cmdGenerate ─────────────────────────────────────────────

describe("cmdGenerate", () => {
  it("errors when not in canonical mode", async () => {
    mockIsCanonical.mockResolvedValue(false);
    await cmdGenerate([]);
    expect(allError()).toContain("Not in canonical mode");
  });

  it("generates for all engines", async () => {
    mockIsCanonical.mockResolvedValue(true);
    await cmdGenerate([]);
    expect(mockHooksRun).toHaveBeenCalledWith(["generate"]);
    expect(mockMcpRun).toHaveBeenCalledWith(["generate"]);
    expect(mockSkillsRun).toHaveBeenCalledWith(["generate"]);
    expect(mockAgentsRun).toHaveBeenCalledWith(["generate"]);
    expect(mockRulesRun).toHaveBeenCalledWith(["generate"]);
  });

  it("respects --dry-run flag", async () => {
    mockIsCanonical.mockResolvedValue(true);
    await cmdGenerate(["--dry-run"]);
    expect(allLog()).toContain("[dry-run]");
  });

  it("catches engine errors and continues", async () => {
    mockIsCanonical.mockResolvedValue(true);
    mockHooksRun.mockRejectedValueOnce(new Error("hooks error"));
    await cmdGenerate([]);
    expect(allError()).toContain("hooks error");
    expect(mockMcpRun).toHaveBeenCalled();
  });
});

// ── cmdInstall ──────────────────────────────────────────────

describe("cmdInstall", () => {
  it("errors when not in canonical mode", async () => {
    mockIsCanonical.mockResolvedValue(false);
    await cmdInstall([]);
    expect(allError()).toContain("Not in canonical mode");
  });

  it("installs all engines and updates manifest", async () => {
    mockIsCanonical.mockResolvedValue(true);
    mockReadManifest.mockResolvedValue({ version: 1, entries: [] });
    mockExistsSync.mockReturnValue(false);
    await cmdInstall([]);
    expect(mockHooksRun).toHaveBeenCalledWith(["install"]);
    expect(mockWriteManifest).toHaveBeenCalled();
    expect(allLog()).toContain("Installed 5 engine(s)");
  });

  it("replaces an existing manifest entry for the same engine", async () => {
    mockIsCanonical.mockResolvedValue(true);
    mockExistsSync.mockReturnValue(false);
    mockReadManifest.mockResolvedValue({
      version: 1,
      entries: [
        {
          engine: "hooks",
          id: "hooks",
          canonicalPath: ".ai-tools/hooks/",
          targets: [],
          updatedAt: "2020-01-01T00:00:00Z",
        },
      ],
    });

    await cmdInstall([]);

    const written = mockWriteManifest.mock.calls[0]?.[0] as {
      entries: Array<{ engine: string; updatedAt: string }>;
    };
    const hooks = written.entries.filter((entry) => entry.engine === "hooks");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.updatedAt).not.toBe("2020-01-01T00:00:00Z");
  });

  it("continues installing after an engine throws", async () => {
    mockIsCanonical.mockResolvedValue(true);
    mockReadManifest.mockResolvedValue({ version: 1, entries: [] });
    mockExistsSync.mockReturnValue(false);
    mockHooksRun.mockRejectedValueOnce(new Error("hooks install failed"));
    mockMcpRun.mockRejectedValueOnce("mcp exploded");

    await cmdInstall([]);

    expect(allError()).toContain("hooks install failed");
    expect(allError()).toContain("mcp exploded");
    expect(mockSkillsRun).toHaveBeenCalled();
    expect(mockWriteManifest).toHaveBeenCalled();
  });

  it("records existing tool directories as manifest targets instead of an empty list", async () => {
    mockIsCanonical.mockResolvedValue(true);
    mockReadManifest.mockResolvedValue({ version: 1, entries: [] });
    mockExistsSync.mockImplementation((path: unknown) => {
      const value = String(path).replaceAll("\\", "/");
      return value.endsWith("/.claude") || value.endsWith("/.grok") || value.endsWith("/.zcode");
    });

    await cmdInstall([]);

    const written = mockWriteManifest.mock.calls[0]?.[0] as {
      entries: Array<{ engine: string; targets: Array<{ adapterId: string; targetPath: string }> }>;
    };
    const hooksEntry = written.entries.find((entry) => entry.engine === "hooks");
    expect(hooksEntry?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          adapterId: "claude-code",
          targetPath: ".claude",
          strategy: "transform",
          status: "direct",
        }),
        expect.objectContaining({ adapterId: "grok", targetPath: ".grok" }),
        expect.objectContaining({ adapterId: "zcode", targetPath: ".zcode" }),
      ]),
    );
    expect(hooksEntry?.targets).toHaveLength(3);
    expect(allLog().toLowerCase()).not.toContain("canonical store");
  });

  it("respects --dry-run flag", async () => {
    mockIsCanonical.mockResolvedValue(true);
    mockReadManifest.mockResolvedValue({ version: 1, entries: [] });
    await cmdInstall(["--dry-run"]);
    expect(mockWriteManifest).not.toHaveBeenCalled();
    expect(allLog()).toContain("[dry-run]");
  });
});

// ── cmdStatus ───────────────────────────────────────────────

describe("cmdStatus", () => {
  it("displays mode, gitignore status, and manifest entries", async () => {
    mockGetMode.mockResolvedValue("canonical");
    mockHasManagedBlock.mockResolvedValue(true);
    mockReadManifest.mockResolvedValue({
      version: 1,
      entries: [
        {
          engine: "skills",
          id: "skills",
          canonicalPath: ".ai-tools/skills/",
          targets: [
            {
              adapterId: "claude-code",
              targetPath: ".claude/commands/review.md",
              strategy: "symlink",
              status: "linked",
            },
          ],
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    mockExistsSync.mockReturnValue(false);

    await cmdStatus([]);
    const output = allLog();
    expect(output).toContain("Mode: canonical");
    expect(output).toContain("Gitignore managed: yes");
    expect(output).toContain("Manifest entries: 1");
    expect(output).toContain("skills/skills");
  });

  it("shows tool directory presence", async () => {
    mockGetMode.mockResolvedValue("direct");
    mockHasManagedBlock.mockResolvedValue(false);
    mockReadManifest.mockResolvedValue({ version: 1, entries: [] });
    mockExistsSync.mockImplementation((path: unknown) => {
      const p = String(path).replaceAll("\\", "/");
      // Check that path ends with the tool directory (not just contains)
      return p.endsWith("/.claude") || p.endsWith("/.claude/");
    });

    await cmdStatus([]);
    const output = allLog();
    expect(output).toContain("+ .claude");
    expect(output).toContain("- .cursor");
  });
});

// ── cmdClean ────────────────────────────────────────────────

describe("cmdClean", () => {
  it("removes existing tool directories", async () => {
    mockExistsSync.mockReturnValue(true);
    await cmdClean([]);
    expect(mockRm).toHaveBeenCalled();
    expect(mockRemoveManagedBlock).toHaveBeenCalled();
    expect(allLog()).toContain("Removed:");
  });

  it("reports when no directories found", async () => {
    mockExistsSync.mockReturnValue(false);
    await cmdClean([]);
    expect(allLog()).toContain("No tool directories found");
  });

  it("respects --dry-run flag", async () => {
    mockExistsSync.mockReturnValue(true);
    await cmdClean(["--dry-run"]);
    expect(mockRm).not.toHaveBeenCalled();
    expect(mockRemoveManagedBlock).not.toHaveBeenCalled();
    expect(allLog()).toContain("[dry-run]");
  });
});
