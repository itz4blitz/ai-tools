import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { RooCodeAgentAdapter } from "./roo-code.js";
import type { AgentDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-agents-roo-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("RooCodeAgentAdapter", () => {
  let adapter: RooCodeAgentAdapter;

  const testAgent: AgentDefinition = {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews pull requests for quality and security",
    instructions: "Review all code changes carefully.",
    tools: ["read", "edit", "command"],
  };

  beforeEach(() => {
    adapter = new RooCodeAgentAdapter();
  });

  describe("metadata", () => {
    it("has correct id", () => expect(adapter.id).toBe("roo-code"));
    it("has correct name", () => expect(adapter.name).toBe("Roo Code"));
    it("has native support", () => expect(adapter.nativeSupport).toBe(true));
    it("has correct configDir", () => expect(adapter.configDir).toBe(".roo"));
    it("uses transform installStrategy", () => expect(adapter.installStrategy).toBe("transform"));
  });

  describe("generate", () => {
    it("returns empty array for no agents", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });

    it("generates single JSON .roomodes file with customModes", async () => {
      const files = await adapter.generate([testAgent]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".roomodes");
      expect(files[0]!.format).toBe("json");
      expect(files[0]!.content.endsWith("\n")).toBe(true);

      const parsed = JSON.parse(files[0]!.content) as {
        customModes: Array<{
          slug: string;
          name: string;
          description?: string;
          whenToUse?: string;
          roleDefinition: string;
          groups: string[];
        }>;
      };
      expect(parsed.customModes).toEqual([
        {
          slug: "reviewer",
          name: "Code Reviewer",
          description: "Reviews pull requests for quality and security",
          whenToUse: "Reviews pull requests for quality and security",
          roleDefinition: "Review all code changes carefully.",
          groups: ["read", "edit", "command"],
        },
      ]);
    });

    it("uses default groups and omits description/whenToUse when absent", async () => {
      const agent: AgentDefinition = {
        id: "simple",
        name: "Simple",
        instructions: "Do stuff.",
      };
      const files = await adapter.generate([agent]);
      const parsed = JSON.parse(files[0]!.content) as {
        customModes: Array<Record<string, unknown>>;
      };
      expect(parsed.customModes[0]).toEqual({
        slug: "simple",
        name: "Simple",
        roleDefinition: "Do stuff.",
        groups: ["read", "edit", "command"],
      });
    });

    it("generates multiple agents in a single file", async () => {
      const files = await adapter.generate([
        testAgent,
        { id: "fixer", name: "Bug Fixer", instructions: "Fix bugs." },
      ]);
      expect(files).toHaveLength(1);
      const parsed = JSON.parse(files[0]!.content) as {
        customModes: Array<{ slug: string }>;
      };
      expect(parsed.customModes.map((m) => m.slug)).toEqual(["reviewer", "fixer"]);
    });
  });

  describe("import", () => {
    it("returns empty array when .roomodes does not exist", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(dir)).toEqual([]);
      });
    });

    it("imports JSON .roomodes with tuple groups and description/whenToUse", async () => {
      await withTempDir(async (dir) => {
        await writeFile(
          join(dir, ".roomodes"),
          JSON.stringify(
            {
              customModes: [
                {
                  slug: "docs-writer",
                  name: "Docs Writer",
                  description: "Writes documentation",
                  roleDefinition: "Maintain markdown docs.",
                  groups: [
                    "read",
                    ["edit", { fileRegex: "\\.md$", description: "Markdown files only" }],
                    "mcp",
                  ],
                },
                {
                  slug: "triage",
                  name: "Triage",
                  whenToUse: "Use for triaging issues",
                  roleDefinition: "Triage incoming bugs.",
                  groups: ["read"],
                },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );

        const agents = await adapter.import(dir);
        expect(agents).toEqual([
          {
            id: "docs-writer",
            name: "Docs Writer",
            description: "Writes documentation",
            instructions: "Maintain markdown docs.",
            tools: ["read", "edit", "mcp"],
          },
          {
            id: "triage",
            name: "Triage",
            description: "Use for triaging issues",
            instructions: "Triage incoming bugs.",
            tools: ["read"],
          },
        ]);
      });
    });

    it("imports YAML .roomodes without crashing and normalizes tuple groups", async () => {
      await withTempDir(async (dir) => {
        const yamlContent = [
          "# Roo Code custom modes",
          "customModes:",
          "  - slug: architect",
          "    name: System Architect",
          '    description: "Designs systems"',
          "    roleDefinition: |-",
          "      You are a software architect.",
          "      Focus on boundaries and clarity.",
          "    groups:",
          "      - read",
          "      - - edit",
          "        - fileRegex: \\.md$",
          '          description: "Docs only"',
          '      - ["command", { description: "Run diagnostics" }]',
          "      - mcp",
          "  - slug: quick-fix",
          "    name: 'Quick Fix'",
          "    whenToUse: Use for small bugfixes",
          "    roleDefinition: Fix small issues quickly.",
          "    groups: [read, edit]",
          "",
        ].join("\r\n");

        await writeFile(join(dir, ".roomodes"), yamlContent, "utf-8");

        const agents = await adapter.import(dir);
        expect(agents).toEqual([
          {
            id: "architect",
            name: "System Architect",
            description: "Designs systems",
            instructions: "You are a software architect.\nFocus on boundaries and clarity.",
            tools: ["read", "edit", "command", "mcp"],
          },
          {
            id: "quick-fix",
            name: "Quick Fix",
            description: "Use for small bugfixes",
            instructions: "Fix small issues quickly.",
            tools: ["read", "edit"],
          },
        ]);
      });
    });

    it("handles empty or malformed .roomodes gracefully", async () => {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, ".roomodes"), "not: valid: [roomodes", "utf-8");
        expect(await adapter.import(dir)).toEqual([]);

        await writeFile(join(dir, ".roomodes"), JSON.stringify({}), "utf-8");
        expect(await adapter.import(dir)).toEqual([]);
      });
    });

    it("imports without cwd argument using process.cwd()", async () => {
      await withTempDir(async (dir) => {
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
        try {
          expect(await adapter.import()).toEqual([]);
        } finally {
          cwdSpy.mockRestore();
        }
      });
    });
  });

  describe("install", () => {
    it("merges incoming modes by slug into existing JSON .roomodes", async () => {
      await withTempDir(async (dir) => {
        await writeFile(
          join(dir, ".roomodes"),
          JSON.stringify(
            {
              customModes: [
                {
                  slug: "keep-me",
                  name: "Keep Me",
                  roleDefinition: "Untouched mode.",
                  groups: ["read"],
                },
                {
                  slug: "reviewer",
                  name: "Old Reviewer",
                  roleDefinition: "Old prompt.",
                  customInstructions: "Keep custom instructions",
                  groups: ["read"],
                },
              ],
            },
            null,
            2,
          ),
          "utf-8",
        );

        const files = await adapter.generate([
          testAgent,
          { id: "new-mode", name: "New Mode", instructions: "Brand new." },
        ]);
        await adapter.install(files, dir);

        const parsed = JSON.parse(await readFile(join(dir, ".roomodes"), "utf-8")) as {
          customModes: Array<Record<string, unknown>>;
        };
        expect(parsed.customModes.map((m) => m.slug)).toEqual(["keep-me", "reviewer", "new-mode"]);
        expect(parsed.customModes[0]).toMatchObject({
          slug: "keep-me",
          roleDefinition: "Untouched mode.",
        });
        expect(parsed.customModes[1]).toMatchObject({
          slug: "reviewer",
          name: "Code Reviewer",
          roleDefinition: "Review all code changes carefully.",
          customInstructions: "Keep custom instructions",
        });
        expect(parsed.customModes[2]).toMatchObject({
          slug: "new-mode",
          name: "New Mode",
        });
      });
    });

    it("merges incoming modes by slug when existing .roomodes is YAML", async () => {
      await withTempDir(async (dir) => {
        await writeFile(
          join(dir, ".roomodes"),
          [
            "customModes:",
            "  - slug: existing-yaml",
            "    name: Existing YAML",
            "    roleDefinition: Stay around.",
            "    groups:",
            "      - read",
            "",
          ].join("\n"),
          "utf-8",
        );

        await adapter.install(await adapter.generate([testAgent]), dir);

        const imported = await adapter.import(dir);
        expect(imported.map((a) => a.id)).toEqual(["existing-yaml", "reviewer"]);
      });
    });
  });

  describe("detect", () => {
    it("detects when .roomodes exists", async () => {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, ".roomodes"), "{}\n", "utf-8");
        expect(await adapter.detect(dir)).toBe(true);
      });
    });

    it("detects when .roo directory exists", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".roo"), { recursive: true });
        expect(await adapter.detect(dir)).toBe(true);
      });
    });

    it("returns false when neither .roomodes nor .roo exists", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.detect(dir)).toBe(false);
      });
    });
  });

  describe("uninstall", () => {
    it("removes .roomodes while leaving .roo directory intact", async () => {
      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".roo"), { recursive: true });
        await writeFile(join(dir, ".roo/mcp.json"), "{}\n", "utf-8");
        await adapter.install(await adapter.generate([testAgent]), dir);

        await adapter.uninstall(dir);

        expect(existsSync(join(dir, ".roomodes"))).toBe(false);
        expect(existsSync(join(dir, ".roo/mcp.json"))).toBe(true);
      });
    });

    it("is a no-op when .roomodes is missing", async () => {
      await withTempDir(async (dir) => {
        await expect(adapter.uninstall(dir)).resolves.toBeUndefined();
      });
    });
  });
});
