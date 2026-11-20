import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CopilotRuleAdapter } from "./copilot.js";

describe("CopilotRuleAdapter", () => {
  let adapter: CopilotRuleAdapter;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-copilot-rules-"));
    adapter = new CopilotRuleAdapter();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has expected metadata", () => {
      expect(adapter.id).toBe("copilot");
      expect(adapter.name).toBe("Copilot");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".github/instructions");
      expect(adapter.command).toBe("copilot");
    });
  });

  describe("generate", () => {
    it("emits .instructions.md with applyTo: ** for always scope", async () => {
      const files = await adapter.generate([
        {
          id: "general",
          name: "General Rules",
          description: "Applies everywhere",
          content: "Write clean code.",
          scope: { type: "always" },
        },
      ]);

      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".github/instructions/general.instructions.md");
      expect(files[0]?.content).toContain('applyTo: "**"');
      expect(files[0]?.content).toContain("description: Applies everywhere");
      expect(files[0]?.content).toContain("# General Rules");
      expect(files[0]?.content).toContain("Write clean code.");
    });

    it("emits comma-separated patterns in applyTo for glob scope", async () => {
      const files = await adapter.generate([
        {
          id: "typescript",
          name: "TypeScript",
          content: "Use strict types.",
          scope: { type: "glob", patterns: ["**/*.ts", "**/*.tsx"] },
        },
      ]);

      expect(files[0]?.path).toBe(".github/instructions/typescript.instructions.md");
      expect(files[0]?.content).toContain('applyTo: "**/*.ts,**/*.tsx"');
    });

    it("handles empty rules array", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });
  });

  describe("install, import, and uninstall", () => {
    it("round-trips always and glob rules in a real temp dir", async () => {
      const files = await adapter.generate([
        {
          id: "general",
          name: "General",
          content: "Always apply.",
          scope: { type: "always" },
        },
        {
          id: "ts",
          name: "TS Rules",
          description: "TypeScript guidelines",
          content: "No any.",
          scope: { type: "glob", patterns: ["**/*.ts", "**/*.tsx"] },
        },
      ]);
      await adapter.install(files, tempDir);

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(2);

      const general = imported.find((r) => r.id === "general");
      expect(general).toMatchObject({
        id: "general",
        name: "General",
        content: "Always apply.",
        scope: { type: "always" },
      });

      const ts = imported.find((r) => r.id === "ts");
      expect(ts).toMatchObject({
        id: "ts",
        name: "TS Rules",
        description: "TypeScript guidelines",
        content: "No any.",
        scope: { type: "glob", patterns: ["**/*.ts", "**/*.tsx"] },
      });
    });

    it("imports .github/copilot-instructions.md and handles CRLF frontmatter", async () => {
      await mkdir(join(tempDir, ".github/instructions"), { recursive: true });
      await writeFile(
        join(tempDir, ".github/copilot-instructions.md"),
        "# Repo Instructions\r\n\r\nFollow repo conventions.\r\n",
      );
      await writeFile(
        join(tempDir, ".github/instructions/win.instructions.md"),
        '---\r\napplyTo: "src/**/*.ts"\r\n---\r\n\r\nUse ESM imports.\r\n',
      );

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(2);

      const repoRule = imported.find((r) => r.id === "copilot-instructions");
      expect(repoRule).toEqual({
        id: "copilot-instructions",
        name: "Repo Instructions",
        content: "Follow repo conventions.",
        scope: { type: "always" },
      });

      const winRule = imported.find((r) => r.id === "win");
      expect(winRule).toEqual({
        id: "win",
        name: "win",
        content: "Use ESM imports.",
        scope: { type: "glob", patterns: ["src/**/*.ts"] },
      });
    });

    it("handles manual scope, special description chars, and single-quoted frontmatter", async () => {
      const files = await adapter.generate([
        {
          id: "manual-rule",
          name: "Manual Rule",
          description: "Rule: #1 manual",
          content: "Apply on demand.",
          scope: { type: "manual" },
        },
      ]);
      expect(files[0]?.content).toContain('description: "Rule: #1 manual"');
      await adapter.install(files, tempDir);

      await writeFile(
        join(tempDir, ".github/instructions/single.instructions.md"),
        "---\napplyTo: '**'\ndescription: 'It''s global'\n---\n\nAlways.\n",
      );

      const imported = await adapter.import(tempDir);
      expect(imported.find((r) => r.id === "manual-rule")).toMatchObject({
        scope: { type: "manual" },
        description: "Rule: #1 manual",
      });
      expect(imported.find((r) => r.id === "single")).toMatchObject({
        scope: { type: "always" },
        description: "It's global",
      });
    });

    it("returns empty array when neither file nor dir exists", async () => {
      expect(await adapter.import(tempDir)).toEqual([]);
    });

    it("uninstalls .instructions.md files without touching copilot-instructions.md", async () => {
      const files = await adapter.generate([
        { id: "general", name: "General", content: "Body", scope: { type: "always" } },
      ]);
      await adapter.install(files, tempDir);
      const repoInstructions = join(tempDir, ".github/copilot-instructions.md");
      await writeFile(repoInstructions, "# Keep me\n\nUser repo instructions.");

      await adapter.uninstall(tempDir);
      expect(existsSync(join(tempDir, ".github/instructions/general.instructions.md"))).toBe(false);
      expect(existsSync(join(tempDir, ".github/instructions"))).toBe(false);
      expect(existsSync(repoInstructions)).toBe(true);
    });
  });
});
