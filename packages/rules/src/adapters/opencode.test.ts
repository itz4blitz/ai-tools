import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({ registry: { register: vi.fn() } }));

import { OpenCodeRuleAdapter } from "./opencode.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-rules-opencode-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("OpenCodeRuleAdapter", () => {
  let adapter: OpenCodeRuleAdapter;

  beforeEach(() => {
    adapter = new OpenCodeRuleAdapter();
  });

  describe("metadata", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("opencode");
      expect(adapter.name).toBe("OpenCode");
      expect(adapter.configDir).toBe(".opencode/instructions");
    });
  });

  describe("generate", () => {
    it("generates markdown files under .opencode/instructions", async () => {
      const files = await adapter.generate([
        { id: "test", name: "Test", content: "Content", scope: { type: "always" } },
      ]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".opencode/instructions/test.md");
      expect(files[0]!.content).toContain("# Test");
    });

    it("handles empty rules", async () => {
      expect(await adapter.generate([])).toHaveLength(0);
    });
  });

  describe("install & uninstall", () => {
    it("writes rules and registers .opencode/instructions/*.md in opencode.json without clobbering existing config", async () => {
      await withTempDir(async (dir) => {
        const configPath = join(dir, "opencode.json");
        await writeFile(
          configPath,
          JSON.stringify(
            {
              mcp: { srv: { type: "remote", url: "https://example.com" } },
              instructions: ["CUSTOM.md"],
            },
            null,
            2,
          ),
        );

        const files = await adapter.generate([
          {
            id: "style",
            name: "Style Guide",
            content: "Use strict TS.",
            scope: { type: "always" },
          },
        ]);
        await adapter.install(files, dir);

        expect(existsSync(join(dir, ".opencode/instructions/style.md"))).toBe(true);
        const config = JSON.parse(await readFile(configPath, "utf-8")) as {
          mcp: Record<string, unknown>;
          instructions: string[];
        };
        expect(config.mcp.srv).toBeDefined();
        expect(config.instructions).toEqual(["CUSTOM.md", ".opencode/instructions/*.md"]);

        // Re-installing does not duplicate the glob
        await adapter.install(files, dir);
        const config2 = JSON.parse(await readFile(configPath, "utf-8")) as {
          instructions: string[];
        };
        expect(config2.instructions).toEqual(["CUSTOM.md", ".opencode/instructions/*.md"]);

        // Uninstall removes instructions dir and only our glob from opencode.json
        await adapter.uninstall(dir);
        expect(existsSync(join(dir, ".opencode/instructions"))).toBe(false);
        expect(existsSync(configPath)).toBe(true);
        const afterUninstall = JSON.parse(await readFile(configPath, "utf-8")) as {
          mcp: Record<string, unknown>;
          instructions: string[];
        };
        expect(afterUninstall.mcp.srv).toBeDefined();
        expect(afterUninstall.instructions).toEqual(["CUSTOM.md"]);
      });
    });

    it("deletes opencode.json on uninstall when instructions was the only entry", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([
          { id: "style", name: "Style", content: "Body", scope: { type: "always" } },
        ]);
        await adapter.install(files, dir);
        expect(existsSync(join(dir, "opencode.json"))).toBe(true);

        await adapter.uninstall(dir);
        expect(existsSync(join(dir, ".opencode/instructions"))).toBe(false);
        expect(existsSync(join(dir, "opencode.json"))).toBe(false);
      });
    });
  });

  describe("import & detect", () => {
    it("returns empty when neither .opencode/instructions nor AGENTS.md exists", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(dir)).toEqual([]);
      });
    });

    it("imports rules from .opencode/instructions and AGENTS.md", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".opencode/instructions"), { recursive: true });
        await writeFile(
          join(dir, ".opencode/instructions/rule.md"),
          "# My Rule\n\nContent here.\n",
        );
        await writeFile(join(dir, ".opencode/instructions/readme.txt"), "skip me");
        await writeFile(join(dir, "AGENTS.md"), "# Project Instructions\n\nFollow conventions.\n");

        const result = await adapter.import(dir);
        expect(result).toHaveLength(2);
        expect(result.find((r) => r.id === "rule")).toMatchObject({
          name: "My Rule",
          content: "Content here.",
        });
        expect(result.find((r) => r.id === "agents")).toMatchObject({
          name: "Project Instructions",
          content: "Follow conventions.",
        });
      });
    });

    it("detects .opencode/instructions, opencode.json, opencode.jsonc, and AGENTS.md", async () => {
      await withTempDir(async (dir) => {
        const cmdSpy = vi
          .spyOn(adapter as unknown as { commandExists: () => Promise<boolean> }, "commandExists")
          .mockResolvedValue(false);
        try {
          expect(await adapter.detect(dir)).toBe(false);
          await writeFile(join(dir, "AGENTS.md"), "# Agents\n");
          expect(await adapter.detect(dir)).toBe(true);
        } finally {
          cmdSpy.mockRestore();
        }
      });
    });
  });
});
