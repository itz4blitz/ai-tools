import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../types/index.js";
import { CopilotAgentAdapter } from "./copilot.js";

describe("CopilotAgentAdapter", () => {
  let adapter: CopilotAgentAdapter;
  let tempDir: string;

  const testAgent: AgentDefinition = {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews code for bugs and style",
    tools: ["read", "search"],
    model: "gpt-4.1",
    instructions: "Review every diff carefully.",
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-copilot-agents-"));
    adapter = new CopilotAgentAdapter();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has expected metadata, installStrategy, and command", () => {
      expect(adapter.id).toBe("copilot");
      expect(adapter.name).toBe("Copilot");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".github/agents");
      expect(adapter.installStrategy).toBe("transform");
      expect(adapter.command).toBe("copilot");
    });
  });

  describe("generate", () => {
    it("emits .github/agents/<id>.agent.md with YAML frontmatter", async () => {
      const files = await adapter.generate([testAgent]);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".github/agents/reviewer.agent.md");
      expect(files[0]?.format).toBe("md");
      expect(files[0]?.content).toContain("name: Code Reviewer");
      expect(files[0]?.content).toContain("description: Reviews code for bugs and style");
      expect(files[0]?.content).toContain("tools:\n  - read\n  - search");
      expect(files[0]?.content).toContain("model: gpt-4.1");
      expect(files[0]?.content).toContain("Review every diff carefully.");
    });

    it("returns empty array for no agents", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });
  });

  describe("install, import, and uninstall", () => {
    it("round-trips .agent.md files in a real temp dir", async () => {
      const files = await adapter.generate([testAgent]);
      await adapter.install(files, tempDir);

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toEqual({
        id: "reviewer",
        name: "Code Reviewer",
        description: "Reviews code for bugs and style",
        tools: ["read", "search"],
        model: "gpt-4.1",
        instructions: "Review every diff carefully.",
      });
    });

    it("supports CRLF and inline tools arrays on import", async () => {
      const agentsDir = join(tempDir, ".github/agents");
      await mkdir(agentsDir, { recursive: true });
      await writeFile(
        join(agentsDir, "planner.agent.md"),
        '---\r\nname: "Planner"\r\ndescription: Plans tasks\r\ntools: ["read", "edit"]\r\nmodel: claude-sonnet-4\r\n---\r\n\r\nMake a plan.\r\n',
      );
      await writeFile(join(agentsDir, "README.md"), "# Ignored non-agent file");

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toEqual({
        id: "planner",
        name: "Planner",
        description: "Plans tasks",
        tools: ["read", "edit"],
        model: "claude-sonnet-4",
        instructions: "Make a plan.",
      });
    });

    it("does not leak non-tools YAML lists into agent.tools and handles special YAML chars", async () => {
      const agentsDir = join(tempDir, ".github/agents");
      await mkdir(agentsDir, { recursive: true });
      await writeFile(
        join(agentsDir, "handoff.agent.md"),
        [
          "---",
          'name: "Reviewer: Strict"',
          'description: "Checks #1: edge cases"',
          "tags:",
          "  - security",
          "  - review",
          "tools:",
          "  - read",
          "---",
          "",
          "Audit carefully.",
        ].join("\n"),
      );

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toEqual({
        id: "handoff",
        name: "Reviewer: Strict",
        description: "Checks #1: edge cases",
        tools: ["read"],
        instructions: "Audit carefully.",
      });
    });

    it("parses .agent.md without frontmatter and single-quoted YAML values", async () => {
      const agentsDir = join(tempDir, ".github/agents");
      await mkdir(agentsDir, { recursive: true });
      await writeFile(join(agentsDir, "plain.agent.md"), "# Plain Agent\n\nDo plain things.\n");
      await writeFile(
        join(agentsDir, "single.agent.md"),
        "---\nname: 'O''Connor'\ndescription: 'Single quoted'\nmodel: 'gpt-4'\n---\n\nAct.\n",
      );

      const imported = await adapter.import(tempDir);
      expect(imported.find((a) => a.id === "plain")).toEqual({
        id: "plain",
        name: "Plain Agent",
        instructions: "Do plain things.",
      });
      expect(imported.find((a) => a.id === "single")).toEqual({
        id: "single",
        name: "O'Connor",
        description: "Single quoted",
        model: "gpt-4",
        instructions: "Act.",
      });
    });

    it("returns empty array when config dir is missing", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });

    it("uninstalls .agent.md files while preserving unrelated files", async () => {
      const files = await adapter.generate([testAgent]);
      await adapter.install(files, tempDir);
      const keepPath = join(tempDir, ".github/agents/README.md");
      await writeFile(keepPath, "Keep me");

      await adapter.uninstall(tempDir);
      expect(existsSync(join(tempDir, ".github/agents/reviewer.agent.md"))).toBe(false);
      expect(existsSync(keepPath)).toBe(true);
    });

    it("removes .github/agents directory when empty after uninstall", async () => {
      const files = await adapter.generate([testAgent]);
      await adapter.install(files, tempDir);
      await adapter.uninstall(tempDir);
      expect(existsSync(join(tempDir, ".github/agents"))).toBe(false);
    });
  });
});
