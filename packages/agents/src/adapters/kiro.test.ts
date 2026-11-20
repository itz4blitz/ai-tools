import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KiroAgentAdapter } from "./kiro.js";
import type { AgentDefinition } from "../types/index.js";

describe("KiroAgentAdapter", () => {
  let adapter: KiroAgentAdapter;
  let tempDir: string;

  const testAgent: AgentDefinition = {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews code for quality",
    model: "claude-sonnet-4",
    tools: ["fs_read", "execute_bash"],
    instructions: "Review every diff carefully.",
  };

  beforeEach(async () => {
    adapter = new KiroAgentAdapter();
    tempDir = await mkdtemp(join(tmpdir(), "kiro-agents-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct id, name, nativeSupport, and configDir", () => {
      expect(adapter.id).toBe("kiro");
      expect(adapter.name).toBe("Kiro");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".kiro/agents");
    });
  });

  describe("generate", () => {
    it("emits name in frontmatter alongside description, tools, and model", async () => {
      const files = await adapter.generate([testAgent]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".kiro/agents/reviewer.md");
      expect(files[0]!.format).toBe("md");
      expect(files[0]!.content).toContain("---\nname: Code Reviewer\n");
      expect(files[0]!.content).toContain("description: Reviews code for quality\n");
      expect(files[0]!.content).toContain("tools:\n  - fs_read\n  - execute_bash\n");
      expect(files[0]!.content).toContain("model: claude-sonnet-4\n");
      expect(files[0]!.content).toContain("Review every diff carefully.");
    });

    it("returns empty array for no agents", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });
  });

  describe("install, import (.md and .json), and uninstall", () => {
    it("imports both .kiro/agents/*.md (including CRLF) and .kiro/agents/*.json", async () => {
      const files = await adapter.generate([testAgent]);
      await adapter.install(files, tempDir);

      const agentsDir = join(tempDir, ".kiro", "agents");
      await writeFile(
        join(agentsDir, "architect.json"),
        JSON.stringify({
          name: "System Architect",
          description: "Designs architecture",
          prompt: "Think in trade-offs.",
          model: "claude-opus-4",
          tools: ["fs_read"],
        }),
        "utf-8",
      );
      await writeFile(
        join(agentsDir, "crlf-agent.md"),
        "---\r\nname: CRLF Agent\r\ndescription: Windows agent\r\n---\r\n\r\n# CRLF Agent\r\n\r\nHandle CRLF.\r\n",
        "utf-8",
      );
      await writeFile(join(agentsDir, "broken.json"), "{ invalid json", "utf-8");

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(3);

      expect(imported.find((a) => a.id === "reviewer")).toEqual(testAgent);
      expect(imported.find((a) => a.id === "architect")).toEqual({
        id: "architect",
        name: "System Architect",
        description: "Designs architecture",
        instructions: "Think in trade-offs.",
        model: "claude-opus-4",
        tools: ["fs_read"],
      });
      expect(imported.find((a) => a.id === "crlf-agent")).toEqual({
        id: "crlf-agent",
        name: "CRLF Agent",
        description: "Windows agent",
        instructions: "Handle CRLF.",
      });
    });

    it("uninstall removes generated .md agents and cleans up when empty", async () => {
      const files = await adapter.generate([testAgent]);
      await adapter.install(files, tempDir);
      expect(existsSync(join(tempDir, ".kiro", "agents", "reviewer.md"))).toBe(true);

      await adapter.uninstall(tempDir);
      expect(existsSync(join(tempDir, ".kiro", "agents"))).toBe(false);
    });

    it("returns empty array when config dir does not exist", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });
  });

  describe("detect", () => {
    it("detects .kiro/agents dir or kiro / kiro-cli binaries", async () => {
      const spy = vi
        .spyOn(
          adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
          "commandExists",
        )
        .mockImplementation(async (cmd) => cmd === "kiro-cli");

      expect(await adapter.detect(tempDir)).toBe(true);
      expect(spy).toHaveBeenCalledWith("kiro");
      expect(spy).toHaveBeenCalledWith("kiro-cli");

      spy.mockResolvedValue(false);
      expect(await adapter.detect(tempDir)).toBe(false);

      await mkdir(join(tempDir, ".kiro", "agents"), { recursive: true });
      expect(await adapter.detect(tempDir)).toBe(true);
    });
  });
});
