import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { WindsurfAgentAdapter } from "./windsurf.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-agents-windsurf-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("WindsurfAgentAdapter", () => {
  it("generates, installs, and imports markdown agents under .windsurf/agents", async () => {
    const adapter = new WindsurfAgentAdapter();
    expect(adapter.id).toBe("windsurf");
    expect(adapter.name).toBe("Windsurf");
    expect(adapter.nativeSupport).toBe(true);
    expect(adapter.configDir).toBe(".windsurf/agents");
    expect(adapter.command).toBe("windsurf");

    await withTempDir(async (dir) => {
      const files = await adapter.generate([
        {
          id: "reviewer",
          name: "Reviewer",
          description: "Reviews pull requests",
          tools: ["read_file", "grep"],
          instructions: "Check correctness and tests.",
        },
      ]);

      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".windsurf/agents/reviewer.md");
      expect(files[0]?.format).toBe("md");

      await adapter.install(files, dir);
      expect(existsSync(join(dir, ".windsurf/agents/reviewer.md"))).toBe(true);

      const imported = await adapter.import(dir);
      expect(imported).toEqual([
        {
          id: "reviewer",
          name: "Reviewer",
          description: "Reviews pull requests",
          tools: ["read_file", "grep"],
          instructions: "Check correctness and tests.",
        },
      ]);
    });
  });

  it("returns empty array when .windsurf/agents does not exist", async () => {
    const adapter = new WindsurfAgentAdapter();
    await withTempDir(async (dir) => {
      expect(await adapter.import(dir)).toEqual([]);
    });
  });
});
