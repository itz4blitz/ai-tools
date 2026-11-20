import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuleDefinition } from "../types/index.js";
import { AmpRuleAdapter } from "./amp.js";

describe("AmpRuleAdapter", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ai-tools-amp-rules-"));
    dirs.push(dir);
    return dir;
  }

  const alwaysRule: RuleDefinition = {
    id: "ts-strict",
    name: "TypeScript Strict",
    content: "Always enable strict type checking.",
    scope: { type: "always" },
  };

  const globRule: RuleDefinition = {
    id: "react-hooks",
    name: "React Hooks",
    content: "Follow the rules of hooks.",
    scope: { type: "glob", patterns: ["src/**/*.tsx", "packages/ui/**/*.ts"] },
  };

  describe("metadata", () => {
    it("has correct id, name, nativeSupport, and configDir", () => {
      const adapter = new AmpRuleAdapter();
      expect(adapter.id).toBe("amp");
      expect(adapter.name).toBe("Amp");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe("AGENTS.md");
    });
  });

  describe("generate", () => {
    it("returns empty array when rules list is empty", async () => {
      const adapter = new AmpRuleAdapter();
      expect(await adapter.generate([])).toEqual([]);
    });

    it("generates AGENTS.md with managed section markers", async () => {
      const adapter = new AmpRuleAdapter();
      const files = await adapter.generate([alwaysRule]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe("AGENTS.md");
      expect(files[0]!.format).toBe("md");
      expect(files[0]!.content).toContain("<!-- ai-tools:rules:start -->");
      expect(files[0]!.content).toContain("<!-- ai-tools:rules:end -->");
      expect(files[0]!.content).toContain("## TypeScript Strict");
      expect(files[0]!.content).not.toContain("globs:");
    });

    it("includes optional globs frontmatter when glob-scoped rules are present", async () => {
      const adapter = new AmpRuleAdapter();
      const files = await adapter.generate([globRule]);
      expect(files[0]!.content).toContain("---\nglobs:\n");
      expect(files[0]!.content).toContain('  - "src/**/*.tsx"');
      expect(files[0]!.content).toContain('  - "packages/ui/**/*.ts"');
    });
  });

  describe("install, import, detect, and uninstall", () => {
    it("preserves manual user prose when installing into an existing AGENTS.md and updates idempotently", async () => {
      const cwd = await scratch();
      await writeFile(
        join(cwd, "AGENTS.md"),
        "# Project Notes\n\nHand-written guidance for contributors.\n",
        "utf-8",
      );

      const adapter = new AmpRuleAdapter();
      await adapter.install(await adapter.generate([alwaysRule]), cwd);

      const firstPass = await readFile(join(cwd, "AGENTS.md"), "utf-8");
      expect(firstPass).toContain("# Project Notes\n\nHand-written guidance for contributors.");
      expect(firstPass).toContain("## TypeScript Strict");

      // Re-install with updated rules should replace only the managed block
      await adapter.install(await adapter.generate([globRule]), cwd);
      const secondPass = await readFile(join(cwd, "AGENTS.md"), "utf-8");
      expect(secondPass).toContain("# Project Notes\n\nHand-written guidance for contributors.");
      expect(secondPass).not.toContain("## TypeScript Strict");
      expect(secondPass).toContain("## React Hooks");
      expect(secondPass.match(/<!-- ai-tools:rules:start -->/g)).toHaveLength(1);
    });

    it("round-trips managed rules and preserves always vs glob scopes", async () => {
      const cwd = await scratch();
      const adapter = new AmpRuleAdapter();
      const files = await adapter.generate([alwaysRule, globRule]);
      // Mixed always + glob rules must not attach file-level globs frontmatter
      expect(files[0]!.content).not.toContain("---\nglobs:");
      await adapter.install(files, cwd);

      const imported = await adapter.import(cwd);
      expect(imported).toEqual([
        {
          id: "ts-strict",
          name: "TypeScript Strict",
          content: "Always enable strict type checking.",
          scope: { type: "always" },
        },
        {
          id: "react-hooks",
          name: "React Hooks",
          content: "Follow the rules of hooks.",
          scope: { type: "glob", patterns: ["src/**/*.tsx", "packages/ui/**/*.ts"] },
        },
      ]);
    });

    it("updates frontmatter when re-installing purely managed glob rules", async () => {
      const cwd = await scratch();
      const adapter = new AmpRuleAdapter();
      await adapter.install(await adapter.generate([globRule]), cwd);

      const updatedGlobRule: RuleDefinition = {
        id: "api-routes",
        name: "API Routes",
        content: "Validate inputs.",
        scope: { type: "glob", patterns: ["api/**/*.ts"] },
      };
      await adapter.install(await adapter.generate([updatedGlobRule]), cwd);

      const content = await readFile(join(cwd, "AGENTS.md"), "utf-8");
      expect(content).toContain('  - "api/**/*.ts"');
      expect(content).not.toContain("src/**/*.tsx");
    });

    it("ignores non-glob YAML list items in frontmatter", async () => {
      const cwd = await scratch();
      await writeFile(
        join(cwd, "AGENTS.md"),
        '---\ntags:\n  - "frontend"\nglobs:\n  - "src/**/*.ts"\n---\n\n# Rules\n\nFollow lint.\n',
        "utf-8",
      );

      const adapter = new AmpRuleAdapter();
      const imported = await adapter.import(cwd);
      expect(imported).toEqual([
        {
          id: "agents",
          name: "Rules",
          content: "Follow lint.",
          scope: { type: "glob", patterns: ["src/**/*.ts"] },
        },
      ]);
    });

    it("falls back to AGENT.md when AGENTS.md is absent", async () => {
      const cwd = await scratch();
      await writeFile(
        join(cwd, "AGENT.md"),
        '---\r\nglobs:\r\n  - "src/**/*.ts"\r\n---\r\n\r\n# Legacy Guidance\r\n\r\nUse pnpm.\r\n',
        "utf-8",
      );

      const adapter = new AmpRuleAdapter();
      const imported = await adapter.import(cwd);
      expect(imported).toEqual([
        {
          id: "agents",
          name: "Legacy Guidance",
          content: "Use pnpm.",
          scope: { type: "glob", patterns: ["src/**/*.ts"] },
        },
      ]);
    });

    it("returns empty array when neither AGENTS.md nor AGENT.md exists", async () => {
      const cwd = await scratch();
      const adapter = new AmpRuleAdapter();
      expect(await adapter.import(cwd)).toEqual([]);
    });

    it("uninstall removes only the managed section and preserves user prose", async () => {
      const cwd = await scratch();
      await writeFile(
        join(cwd, "AGENTS.md"),
        '# Manual Header\n\nKeep me.\n\n<!-- ai-tools:rules:start -->\n<!-- ai-tools:rule id="x" -->\n## X\n\nBody\n<!-- ai-tools:rules:end -->\n\n## Manual Footer\n',
        "utf-8",
      );

      const adapter = new AmpRuleAdapter();
      await adapter.uninstall(cwd);

      const remaining = await readFile(join(cwd, "AGENTS.md"), "utf-8");
      expect(remaining).toBe("# Manual Header\n\nKeep me.\n\n## Manual Footer\n");
    });

    it("uninstall deletes AGENTS.md when it only contains the managed section (including glob frontmatter)", async () => {
      const cwd = await scratch();
      const adapter = new AmpRuleAdapter();
      await adapter.install(await adapter.generate([globRule]), cwd);
      expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);

      await adapter.uninstall(cwd);
      expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
    });

    it("uninstall does not touch an unmanaged hand-written AGENTS.md", async () => {
      const cwd = await scratch();
      const original = "# Hand-Written\n\nDo not delete.\n";
      await writeFile(join(cwd, "AGENTS.md"), original, "utf-8");

      const adapter = new AmpRuleAdapter();
      await adapter.uninstall(cwd);

      expect(await readFile(join(cwd, "AGENTS.md"), "utf-8")).toBe(original);
    });

    it("detects AGENTS.md, AGENT.md, and .amp directory", async () => {
      const cwd = await scratch();
      const adapter = new AmpRuleAdapter();
      vi.spyOn(
        adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
        "commandExists",
      ).mockResolvedValue(false);

      expect(await adapter.detect(cwd)).toBe(false);

      await writeFile(join(cwd, "AGENT.md"), "# Agent\n", "utf-8");
      expect(await adapter.detect(cwd)).toBe(true);
      await rm(join(cwd, "AGENT.md"));

      await mkdir(join(cwd, ".amp"), { recursive: true });
      expect(await adapter.detect(cwd)).toBe(true);
    });
  });
});
