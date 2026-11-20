import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockHooksRun, mockMcpRun, mockSkillsRun, mockAgentsRun, mockRulesRun } = vi.hoisted(() => ({
  mockHooksRun: vi.fn(),
  mockMcpRun: vi.fn(),
  mockSkillsRun: vi.fn(),
  mockAgentsRun: vi.fn(),
  mockRulesRun: vi.fn(),
}));

vi.mock("@itz4blitz/ai-tools-hooks/cli", () => ({ run: mockHooksRun }));
vi.mock("@itz4blitz/ai-tools-mcp/cli", () => ({ run: mockMcpRun }));
vi.mock("@itz4blitz/ai-tools-skills/cli", () => ({ run: mockSkillsRun }));
vi.mock("@itz4blitz/ai-tools-agents/cli", () => ({ run: mockAgentsRun }));
vi.mock("@itz4blitz/ai-tools-rules/cli", () => ({ run: mockRulesRun }));

import { cmdClean, cmdInit, cmdInstall } from "./commands.js";

describe("canonical commands (temp-dir integration)", () => {
  let tempDir: string;
  let originalCwd: string;
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let exitCode: number | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalCwd = process.cwd();
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-canonical-"));
    process.chdir(tempDir);
    exitCode = undefined;

    console.log = vi.fn();
    console.error = vi.fn();
    process.exit = vi.fn((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${code})`);
    }) as never;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("refuses cmdClean in direct mode and leaves user directories intact", async () => {
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await writeFile(join(tempDir, ".claude", "settings.local.json"), '{"user":true}', "utf-8");

    await expect(cmdClean([])).rejects.toThrow("process.exit(1)");
    expect(exitCode).toBe(1);
    expect(existsSync(join(tempDir, ".claude", "settings.local.json"))).toBe(true);
  });

  it("records only actually installed files in manifest and cleans only tracked targets", async () => {
    // Pre-existing unmanaged user files in .claude and .cursor
    await mkdir(join(tempDir, ".claude"), { recursive: true });
    await writeFile(join(tempDir, ".claude", "settings.local.json"), '{"user":true}', "utf-8");
    await mkdir(join(tempDir, ".cursor"), { recursive: true });
    await writeFile(join(tempDir, ".cursor", "user-note.md"), "keep me", "utf-8");
    await writeFile(join(tempDir, "ai-hooks.config.ts"), "export default {};", "utf-8");

    await cmdInit([]);

    // Only hooks engine actually writes a file into .claude; other engines write nothing
    mockHooksRun.mockImplementationOnce(async () => {
      await writeFile(join(tempDir, ".claude", "hooks.json"), '{"managed":true}', "utf-8");
    });

    await cmdInstall([]);

    const manifestRaw = await readFile(join(tempDir, ".ai-tools", "manifest.json"), "utf-8");
    const manifest = JSON.parse(manifestRaw) as {
      entries: Array<{
        engine: string;
        canonicalPath: string;
        targets: Array<{ adapterId: string; targetPath: string }>;
      }>;
    };

    // Only hooks produced an entry; untouched .cursor and .claude/settings.local.json are NOT tracked
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.engine).toBe("hooks");
    expect(manifest.entries[0]?.canonicalPath).toBe("ai-hooks.config.ts");
    expect(manifest.entries[0]?.targets).toEqual([
      expect.objectContaining({
        adapterId: "claude-code",
        targetPath: ".claude/hooks.json",
      }),
    ]);

    // Clean removes only .claude/hooks.json and preserves unmanaged user files
    await cmdClean([]);

    expect(existsSync(join(tempDir, ".claude", "hooks.json"))).toBe(false);
    expect(existsSync(join(tempDir, ".claude", "settings.local.json"))).toBe(true);
    expect(existsSync(join(tempDir, ".cursor", "user-note.md"))).toBe(true);

    const clearedRaw = await readFile(join(tempDir, ".ai-tools", "manifest.json"), "utf-8");
    const cleared = JSON.parse(clearedRaw) as { entries: unknown[] };
    expect(cleared.entries).toEqual([]);
  });

  it("tracks newly created empty tool directories, resolves .ai-tools/<engine>/, and prunes stale entries", async () => {
    await cmdInit([]);
    await mkdir(join(tempDir, ".ai-tools", "hooks"), { recursive: true });

    // Engine creates an empty .windsurf directory
    mockHooksRun.mockImplementationOnce(async () => {
      await mkdir(join(tempDir, ".windsurf"), { recursive: true });
    });

    await cmdInstall([]);

    const manifest1 = JSON.parse(
      await readFile(join(tempDir, ".ai-tools", "manifest.json"), "utf-8"),
    ) as {
      entries: Array<{
        engine: string;
        canonicalPath: string;
        targets: Array<{ adapterId: string; targetPath: string }>;
      }>;
    };
    expect(manifest1.entries).toHaveLength(1);
    expect(manifest1.entries[0]?.canonicalPath).toBe(".ai-tools/hooks/");
    expect(manifest1.entries[0]?.targets).toEqual([
      expect.objectContaining({ adapterId: "windsurf", targetPath: ".windsurf" }),
    ]);

    // Remove .windsurf externally and re-run install; stale entry should be pruned
    await rm(join(tempDir, ".windsurf"), { recursive: true, force: true });
    await cmdInstall([]);

    const manifest2 = JSON.parse(
      await readFile(join(tempDir, ".ai-tools", "manifest.json"), "utf-8"),
    ) as { entries: unknown[] };
    expect(manifest2.entries).toEqual([]);
  });
});
