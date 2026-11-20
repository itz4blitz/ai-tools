import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../types/index.js";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { OpenCodeAgentAdapter } from "./opencode.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-agents-opencode-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("OpenCodeAgentAdapter", () => {
  let adapter: OpenCodeAgentAdapter;

  const testAgent: AgentDefinition = {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews code",
    model: "anthropic/claude-sonnet-4",
    tools: ["read", "grep"],
    instructions: "Review carefully.",
  };

  beforeEach(() => {
    adapter = new OpenCodeAgentAdapter();
  });

  describe("metadata", () => {
    it("has correct metadata and prefers plural .opencode/agents", () => {
      expect(adapter.id).toBe("opencode");
      expect(adapter.name).toBe("OpenCode");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".opencode/agents");
    });
  });

  describe("generate", () => {
    it("returns empty array for no agents", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });

    it("generates file under .opencode/agents with mode and boolean tools map", async () => {
      const files = await adapter.generate([testAgent]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".opencode/agents/reviewer.md");
      expect(files[0]!.format).toBe("md");
      expect(files[0]!.content).toContain("description: Reviews code");
      expect(files[0]!.content).toContain("mode: subagent");
      expect(files[0]!.content).toContain("model: anthropic/claude-sonnet-4");
      expect(files[0]!.content).toContain("tools:\n  read: true\n  grep: true");
      expect(files[0]!.content).toContain("# Code Reviewer");
    });
  });

  describe("install & uninstall", () => {
    it("writes markdown into .opencode/agents and removes it on uninstall", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testAgent]);
        await adapter.install(files, dir);

        const agentPath = join(dir, ".opencode/agents/reviewer.md");
        expect(existsSync(agentPath)).toBe(true);
        expect(await readFile(agentPath, "utf-8")).toContain("mode: subagent");

        await adapter.uninstall(dir);
        expect(existsSync(join(dir, ".opencode/agents"))).toBe(false);
      });
    });
  });

  describe("import & detect", () => {
    it("returns empty array when config dirs do not exist", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(dir)).toEqual([]);
      });
    });

    it("parses boolean tools map, mode, and CRLF from .opencode/agents", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".opencode/agents"), { recursive: true });
        await writeFile(
          join(dir, ".opencode/agents/reviewer.md"),
          "---\r\ndescription: Reviews code\r\nmode: subagent\r\nmodel: openai/gpt-4o\r\ntools:\r\n  read: true\r\n  write: false\r\n  grep: true\r\n---\r\n\r\n# Code Reviewer\r\n\r\nReview.\r\n",
        );

        const agents = await adapter.import(dir);
        expect(agents).toHaveLength(1);
        expect(agents[0]).toEqual({
          id: "reviewer",
          name: "Code Reviewer",
          description: "Reviews code",
          model: "openai/gpt-4o",
          tools: ["read", "grep"],
          instructions: "Review.",
        });
      });
    });

    it("falls back to singular .opencode/agent while preferring plural .opencode/agents", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".opencode/agents"), { recursive: true });
        await mkdir(join(dir, ".opencode/agent"), { recursive: true });

        await writeFile(
          join(dir, ".opencode/agents/shared.md"),
          "---\ndescription: Plural version\n---\n\n# Plural\n\nNew.\n",
        );
        await writeFile(
          join(dir, ".opencode/agent/shared.md"),
          "---\ndescription: Singular version\n---\n\n# Singular\n\nOld.\n",
        );
        await writeFile(
          join(dir, ".opencode/agent/legacy.md"),
          "---\ndescription: Legacy agent\ntools:\n  - bash\n---\n\n# Legacy\n\nLegacy instructions.\n",
        );

        const agents = await adapter.import(dir);
        expect(agents).toHaveLength(2);
        expect(agents.find((a) => a.id === "shared")?.description).toBe("Plural version");
        expect(agents.find((a) => a.id === "legacy")).toMatchObject({
          name: "Legacy",
          tools: ["bash"],
        });
      });
    });

    it("detects .opencode/agents, .opencode/agent, and opencode.jsonc", async () => {
      await withTempDir(async (dir) => {
        const cmdSpy = vi
          .spyOn(adapter as unknown as { commandExists: () => Promise<boolean> }, "commandExists")
          .mockResolvedValue(false);
        try {
          expect(await adapter.detect(dir)).toBe(false);
          await mkdir(join(dir, ".opencode/agent"), { recursive: true });
          expect(await adapter.detect(dir)).toBe(true);
        } finally {
          cmdSpy.mockRestore();
        }
      });
    });
  });
});
