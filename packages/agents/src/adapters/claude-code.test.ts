import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../types/index.js";
import { ClaudeCodeAgentAdapter } from "./claude-code.js";

const temps: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-agents-claude-"));
  temps.push(dir);
  return dir;
}

describe("ClaudeCodeAgentAdapter", () => {
  let adapter: ClaudeCodeAgentAdapter;

  const testAgent: AgentDefinition = {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews code for quality",
    instructions: "Review all code changes carefully.",
    model: "claude-sonnet-4-20250514",
    tools: ["Read", "Grep"],
  };

  beforeEach(() => {
    adapter = new ClaudeCodeAgentAdapter();
  });

  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe("metadata", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("claude-code");
      expect(adapter.name).toBe("Claude Code");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".claude/agents");
    });
  });

  describe("generate, install, import, uninstall roundtrip", () => {
    it("emits name and description in frontmatter and roundtrips on disk", async () => {
      const dir = await tempDir();
      const minimal: AgentDefinition = {
        id: "simple",
        name: "Simple Agent",
        instructions: "Do simple tasks.",
      };

      const files = await adapter.generate([testAgent, minimal]);
      expect(files).toHaveLength(2);
      expect(files[0]!.content).toContain("name: Code Reviewer");
      expect(files[0]!.content).toContain("description: Reviews code for quality");
      expect(files[1]!.content).toContain("name: Simple Agent");
      expect(files[1]!.content).toContain("description: Simple Agent");

      await adapter.install(files, dir);
      const imported = await adapter.import(dir);
      expect(imported).toHaveLength(2);

      const reviewer = imported.find((a) => a.id === "reviewer");
      expect(reviewer).toMatchObject({
        id: "reviewer",
        name: "Code Reviewer",
        description: "Reviews code for quality",
        model: "claude-sonnet-4-20250514",
        tools: ["Read", "Grep"],
        instructions: "Review all code changes carefully.",
      });
    });

    it("handles comma-separated tools, inline array tools, and CRLF line endings", async () => {
      const dir = await tempDir();
      const agentsDir = join(dir, ".claude", "agents");
      await mkdir(agentsDir, { recursive: true });

      await writeFile(
        join(agentsDir, "csv.md"),
        "---\r\nname: CSV Agent\r\ndescription: Uses CSV tools\r\ntools: Read, Grep, Bash\r\n---\r\n\r\nCheck files.\r\n",
        "utf-8",
      );
      await writeFile(
        join(agentsDir, "bracket.md"),
        '---\r\nname: Bracket Agent\r\ndescription: "Check: brackets"\r\ntools: [Edit, Write]\r\n---\r\n\r\nEdit files.\r\n',
        "utf-8",
      );

      const imported = await adapter.import(dir);
      expect(imported).toHaveLength(2);

      const csv = imported.find((a) => a.id === "csv");
      expect(csv).toMatchObject({
        name: "CSV Agent",
        description: "Uses CSV tools",
        tools: ["Read", "Grep", "Bash"],
        instructions: "Check files.",
      });

      const bracket = imported.find((a) => a.id === "bracket");
      expect(bracket).toMatchObject({
        name: "Bracket Agent",
        description: "Check: brackets",
        tools: ["Edit", "Write"],
        instructions: "Edit files.",
      });
    });

    it("uninstall removes .claude/agents directory", async () => {
      const dir = await tempDir();
      await adapter.install(await adapter.generate([testAgent]), dir);
      expect(existsSync(join(dir, ".claude/agents/reviewer.md"))).toBe(true);

      await adapter.uninstall(dir);
      expect(existsSync(join(dir, ".claude/agents"))).toBe(false);
    });
  });
});
