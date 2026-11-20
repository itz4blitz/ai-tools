import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../types/index.js";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (error: Error | null) => void) => {
    cb(new Error("not found"));
  }),
  exec: vi.fn((_cmd: string, cb: (error: Error | null) => void) => {
    cb(new Error("not found"));
  }),
}));

import { ContinueAgentAdapter } from "./continue.js";

describe("ContinueAgentAdapter", () => {
  let adapter: InstanceType<typeof ContinueAgentAdapter>;
  let tmp: string;

  const testAgent: AgentDefinition = {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews code for quality",
    instructions: "Review all code changes carefully.",
    tools: ["Read", "Grep"],
    model: "claude-sonnet",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "continue-agents-"));
    adapter = new ContinueAgentAdapter();
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct Continue agent metadata and cn command", () => {
      expect(adapter.id).toBe("continue");
      expect(adapter.name).toBe("Continue");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".continue/agents");
      expect(adapter.command).toBe("cn");
    });
  });

  describe("generate, install & import", () => {
    it("returns empty array for no agents", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });

    it("round-trips agent markdown files in .continue/agents", async () => {
      const files = await adapter.generate([testAgent]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".continue/agents/reviewer.md");
      expect(files[0]?.format).toBe("md");

      await adapter.install(files, tmp);
      const imported = await adapter.import(tmp);
      expect(imported).toEqual([testAgent]);
    });

    it("returns empty array when config dir does not exist", async () => {
      expect(await adapter.import(tmp)).toEqual([]);
    });

    it("skips non-markdown files", async () => {
      await mkdir(join(tmp, ".continue/agents"), { recursive: true });
      await writeFile(join(tmp, ".continue/agents/notes.txt"), "skip", "utf-8");
      await writeFile(
        join(tmp, ".continue/agents/fixer.md"),
        "# Bug Fixer\n\nFix bugs quickly.\n",
        "utf-8",
      );

      const imported = await adapter.import(tmp);
      expect(imported).toEqual([
        { id: "fixer", name: "Bug Fixer", instructions: "Fix bugs quickly." },
      ]);
    });
  });

  describe("detect", () => {
    it("detects .continue/agents directory", async () => {
      expect(await adapter.detect(tmp)).toBe(false);
      await mkdir(join(tmp, ".continue/agents"), { recursive: true });
      expect(await adapter.detect(tmp)).toBe(true);
    });
  });
});
