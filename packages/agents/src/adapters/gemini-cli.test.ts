import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../types/index.js";
import { GeminiCliAgentAdapter } from "./gemini-cli.js";

describe("GeminiCliAgentAdapter", () => {
  let adapter: GeminiCliAgentAdapter;
  let tempDir: string;

  const testAgent: AgentDefinition = {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews code for bugs and security issues",
    tools: ["read_file", "grep_search"],
    model: "gemini-2.5-pro",
    instructions: "Review carefully.",
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-gemini-agents-"));
    adapter = new GeminiCliAgentAdapter();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("gemini-cli");
      expect(adapter.name).toBe("Gemini CLI");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".gemini/agents");
    });
  });

  describe("generate", () => {
    it("returns empty array for no agents", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });

    it("emits required name and description in YAML frontmatter", async () => {
      const files = await adapter.generate([testAgent]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".gemini/agents/reviewer.md");
      expect(files[0]?.format).toBe("md");
      expect(files[0]?.content).toContain(
        "---\nname: reviewer\ndescription: Reviews code for bugs and security issues\n",
      );
      expect(files[0]?.content).toContain("tools:\n  - read_file\n  - grep_search\n");
      expect(files[0]?.content).toContain("model: gemini-2.5-pro\n");
      expect(files[0]?.content).toContain("# Code Reviewer\n\nReview carefully.\n");
    });

    it("falls back to agent.name for required description when omitted", async () => {
      const files = await adapter.generate([
        { id: "helper", name: "Helper Agent", instructions: "Help the user." },
      ]);
      expect(files[0]?.content).toContain("name: helper\ndescription: Helper Agent\n");
    });
  });

  describe("import & uninstall", () => {
    it("returns empty array when config dir does not exist", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });

    it("round-trips agent files and handles CRLF", async () => {
      const agentsDir = join(tempDir, ".gemini", "agents");
      await mkdir(agentsDir, { recursive: true });
      const files = await adapter.generate([testAgent]);
      await writeFile(
        join(agentsDir, "reviewer.md"),
        files[0]!.content.replace(/\n/g, "\r\n"),
        "utf-8",
      );

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toEqual({
        id: "reviewer",
        name: "Code Reviewer",
        description: "Reviews code for bugs and security issues",
        tools: ["read_file", "grep_search"],
        model: "gemini-2.5-pro",
        instructions: "Review carefully.",
      });
    });

    it("removes .gemini/agents on uninstall", async () => {
      const files = await adapter.generate([testAgent]);
      await adapter.install(files, tempDir);
      expect(existsSync(join(tempDir, ".gemini", "agents", "reviewer.md"))).toBe(true);

      await adapter.uninstall(tempDir);
      expect(existsSync(join(tempDir, ".gemini", "agents"))).toBe(false);
    });
  });
});
