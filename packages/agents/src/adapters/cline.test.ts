import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../types/index.js";
import { ClineAgentAdapter } from "./cline.js";

describe("ClineAgentAdapter", () => {
  let adapter: InstanceType<typeof ClineAgentAdapter>;
  let tempDir: string;

  const testAgent: AgentDefinition = {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews code for quality",
    instructions: "Review all code changes carefully.",
  };

  beforeEach(async () => {
    adapter = new ClineAgentAdapter();
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-cline-agents-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("targets .clinerules/workflows", () => {
      expect(adapter.id).toBe("cline");
      expect(adapter.name).toBe("Cline");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".clinerules/workflows");
    });
  });

  describe("generate, install, and import", () => {
    it("returns empty array for no agents", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });

    it("roundtrips agents through .clinerules/workflows/*.md", async () => {
      const files = await adapter.generate([testAgent]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".clinerules/workflows/reviewer.md");
      expect(files[0]!.format).toBe("md");
      expect(files[0]!.content).toContain("---");
      expect(files[0]!.content).toContain("# Code Reviewer");

      await adapter.install(files, tempDir);
      expect(existsSync(join(tempDir, ".clinerules", "workflows", "reviewer.md"))).toBe(true);

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]!.id).toBe("reviewer");
      expect(imported[0]!.name).toBe("Code Reviewer");
      expect(imported[0]!.description).toBe("Reviews code for quality");
      expect(imported[0]!.instructions).toBe("Review all code changes carefully.");
    });

    it("returns empty array when workflows dir does not exist", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });
  });
});
