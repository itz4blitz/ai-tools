import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({ registry: { register: vi.fn() } }));

import { CodexRuleAdapter, MANAGED_END, MANAGED_START } from "./codex.js";
import type { RuleDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-rules-codex-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("CodexRuleAdapter", () => {
  let adapter: CodexRuleAdapter;
  let originalCodexHome: string | undefined;

  const sampleRules: RuleDefinition[] = [
    {
      id: "typescript",
      name: "TypeScript Standards",
      content: "Use strict mode and explicit return types.",
      scope: { type: "always" },
    },
    {
      id: "testing",
      name: "Testing Policy",
      content: "Write unit tests for every bug fix.",
      scope: { type: "always" },
    },
  ];

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    vi.clearAllMocks();
    adapter = new CodexRuleAdapter();
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  });

  describe("metadata", () => {
    it("targets AGENTS.md instead of .codex/instructions", () => {
      expect(adapter.id).toBe("codex");
      expect(adapter.name).toBe("Codex");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe("AGENTS.md");
      expect(adapter.command).toBe("codex");
    });
  });

  describe("generate", () => {
    it("generates AGENTS.md with managed section markers", async () => {
      const files = await adapter.generate(sampleRules);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe("AGENTS.md");
      expect(files[0]?.format).toBe("md");
      expect(files[0]?.content).toContain(MANAGED_START);
      expect(files[0]?.content).toContain(MANAGED_END);
      expect(files[0]?.content).toContain("## TypeScript Standards");
      expect(files[0]?.content).toContain("## Testing Policy");
    });

    it("returns empty array for no rules", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });
  });

  describe("install and uninstall", () => {
    it("preserves manual user prose before and after managed section on install and re-install", async () => {
      await withTempDir(async (dir) => {
        const agentsPath = join(dir, "AGENTS.md");
        await writeFile(agentsPath, "# Project Guide\n\nManual intro paragraph.\n", "utf-8");

        const initialFiles = await adapter.generate([sampleRules[0]!]);
        await adapter.install(initialFiles, dir);

        const afterFirst = await readFile(agentsPath, "utf-8");
        expect(afterFirst).toContain("# Project Guide\n\nManual intro paragraph.");
        expect(afterFirst).toContain(MANAGED_START);
        expect(afterFirst).toContain("## TypeScript Standards");
        expect(afterFirst).toContain(MANAGED_END);

        // Append manual footer after managed block, then re-install with updated rules
        await writeFile(agentsPath, `${afterFirst}\n## Manual Footer\n\nKeep me.\n`, "utf-8");

        const updatedFiles = await adapter.generate([sampleRules[1]!]);
        await adapter.install(updatedFiles, dir);

        const afterSecond = await readFile(agentsPath, "utf-8");
        expect(afterSecond).toContain("Manual intro paragraph.");
        expect(afterSecond).toContain("## Manual Footer\n\nKeep me.");
        expect(afterSecond).toContain("## Testing Policy");
        expect(afterSecond).not.toContain("## TypeScript Standards");

        // Uninstall strips ONLY the managed block and preserves manual prose
        await adapter.uninstall(dir);

        expect(existsSync(agentsPath)).toBe(true);
        const afterUninstall = await readFile(agentsPath, "utf-8");
        expect(afterUninstall).not.toContain(MANAGED_START);
        expect(afterUninstall).not.toContain(MANAGED_END);
        expect(afterUninstall).toContain("Manual intro paragraph.");
        expect(afterUninstall).toContain("## Manual Footer\n\nKeep me.");
      });
    });

    it("deletes AGENTS.md on uninstall when it only contained the managed section", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate(sampleRules);
        await adapter.install(files, dir);

        const agentsPath = join(dir, "AGENTS.md");
        expect(existsSync(agentsPath)).toBe(true);

        await adapter.uninstall(dir);
        expect(existsSync(agentsPath)).toBe(false);
      });
    });

    it("leaves manual-only AGENTS.md untouched on uninstall", async () => {
      await withTempDir(async (dir) => {
        const agentsPath = join(dir, "AGENTS.md");
        const manual = "# Hand-written AGENTS.md\n\nDo not delete.\n";
        await writeFile(agentsPath, manual, "utf-8");

        await adapter.uninstall(dir);
        expect(await readFile(agentsPath, "utf-8")).toBe(manual);
      });
    });
  });

  describe("import", () => {
    it("returns empty array when no AGENTS files exist", async () => {
      await withTempDir(async (dir) => {
        expect(await adapter.import(dir)).toEqual([]);
      });
    });

    it("round-trips managed rules and imports manual prose from AGENTS.md and AGENTS.override.md", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate(sampleRules);
        await adapter.install(files, dir);

        const existing = await readFile(join(dir, "AGENTS.md"), "utf-8");
        await writeFile(
          join(dir, "AGENTS.md"),
          `# Repo Notes\n\nAlways run lint.\n\n${existing}`,
          "utf-8",
        );
        await writeFile(
          join(dir, "AGENTS.override.md"),
          "# Local Override\n\nPrefer fast local checks.\n",
          "utf-8",
        );

        const imported = await adapter.import(dir);
        expect(imported.map((r) => r.id)).toEqual([
          "agents-override",
          "typescript",
          "testing",
          "agents",
        ]);
        expect(imported[0]?.name).toBe("Local Override");
        expect(imported[0]?.content).toBe("Prefer fast local checks.");
        expect(imported[1]?.content).toBe("Use strict mode and explicit return types.");
        expect(imported[3]?.name).toBe("Repo Notes");
        expect(imported[3]?.content).toBe("Always run lint.");
      });
    });

    it("supports importing user-layer ~/.codex/AGENTS.md via CODEX_HOME", async () => {
      await withTempDir(async (dir) => {
        process.env.CODEX_HOME = dir;
        await writeFile(join(dir, "AGENTS.md"), "# Global Codex Rules\n\nBe concise.\n", "utf-8");

        const viaMethod = await adapter.importUser();
        expect(viaMethod).toHaveLength(1);
        expect(viaMethod[0]?.id).toBe("codex-user-agents");
        expect(viaMethod[0]?.name).toBe("Global Codex Rules");
        expect(viaMethod[0]?.content).toBe("Be concise.");

        const viaLayer = await adapter.import(undefined, "user");
        expect(viaLayer).toEqual(viaMethod);
      });
    });
  });

  describe("detect", () => {
    it("detects AGENTS.md, AGENTS.override.md, or .codex directory", async () => {
      await withTempDir(async (dir) => {
        await writeFile(join(dir, "AGENTS.md"), "# Guide\n", "utf-8");
        expect(await adapter.detect(dir)).toBe(true);
      });

      await withTempDir(async (dir) => {
        await writeFile(join(dir, "AGENTS.override.md"), "# Override\n", "utf-8");
        expect(await adapter.detect(dir)).toBe(true);
      });

      await withTempDir(async (dir) => {
        await mkdir(join(dir, ".codex"), { recursive: true });
        expect(await adapter.detect(dir)).toBe(true);
      });
    });
  });
});
