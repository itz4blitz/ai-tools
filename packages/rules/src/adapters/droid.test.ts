import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuleDefinition } from "../types/index.js";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { DroidRuleAdapter } from "./droid.js";

describe("DroidRuleAdapter", () => {
  let adapter: DroidRuleAdapter;
  let tmp: string;

  const ruleA: RuleDefinition = {
    id: "typescript",
    name: "TypeScript Style",
    content: "Always use strict TypeScript types.",
    scope: { type: "always" },
  };

  const ruleB: RuleDefinition = {
    id: "testing",
    name: "Testing Standards",
    content: "Write real temp-dir tests.",
    scope: { type: "always" },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new DroidRuleAdapter();
    tmp = await mkdtemp(join(tmpdir(), "ai-tools-droid-rules-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has standardized Factory Droid metadata targeting AGENTS.md", () => {
      expect(adapter.id).toBe("droid");
      expect(adapter.name).toBe("Factory Droid");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe("AGENTS.md");
      expect(adapter.command).toBe("droid");
    });
  });

  describe("generate & install", () => {
    it("returns empty array for no rules", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });

    it("generates AGENTS.md with managed section markers", async () => {
      const files = await adapter.generate([ruleA, ruleB]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe("AGENTS.md");
      expect(files[0]!.format).toBe("md");
      expect(files[0]!.content).toContain("<!-- ai-tools:rules:start -->");
      expect(files[0]!.content).toContain("<!-- ai-tools:rules:end -->");
      expect(files[0]!.content).toContain("## TypeScript Style");
      expect(files[0]!.content).toContain("## Testing Standards");
    });

    it("preserves existing user content in AGENTS.md on first install and updates in place on re-install", async () => {
      const agentsPath = join(tmp, "AGENTS.md");
      await writeFile(agentsPath, "# Project Notes\n\nKeep this user header.\n", "utf-8");

      await adapter.install(await adapter.generate([ruleA]), tmp);
      let content = await readFile(agentsPath, "utf-8");
      expect(content).toContain("# Project Notes\n\nKeep this user header.");
      expect(content).toContain("## TypeScript Style");

      // Add user footer after managed section and re-install with updated rules
      await writeFile(agentsPath, `${content}\n## User Footer\n\nKeep footer too.\n`, "utf-8");
      await adapter.install(await adapter.generate([ruleB]), tmp);

      content = await readFile(agentsPath, "utf-8");
      expect(content).toContain("Keep this user header.");
      expect(content).toContain("Keep footer too.");
      expect(content).toContain("## Testing Standards");
      expect(content).not.toContain("## TypeScript Style");
    });
  });

  describe("import", () => {
    it("returns empty array when AGENTS.md is missing", async () => {
      expect(await adapter.import(tmp)).toEqual([]);
    });

    it("round-trips managed rules from AGENTS.md", async () => {
      await adapter.install(await adapter.generate([ruleA, ruleB]), tmp);
      const imported = await adapter.import(tmp);
      expect(imported).toEqual([ruleA, ruleB]);
    });

    it("imports plain user-authored AGENTS.md without markers", async () => {
      await writeFile(
        join(tmp, "AGENTS.md"),
        "# Repo Guide\r\n\r\nUse pnpm everywhere.\r\n",
        "utf-8",
      );
      const imported = await adapter.import(tmp);
      expect(imported).toEqual([
        {
          id: "agents",
          name: "AGENTS",
          content: "# Repo Guide\n\nUse pnpm everywhere.",
          scope: { type: "always" },
        },
      ]);
    });
  });

  describe("uninstall", () => {
    it("removes only the managed section and preserves surrounding user content", async () => {
      const agentsPath = join(tmp, "AGENTS.md");
      await writeFile(agentsPath, "# User Notes\n\nKeep me.\n", "utf-8");
      await adapter.install(await adapter.generate([ruleA]), tmp);

      await adapter.uninstall(tmp);
      expect(existsSync(agentsPath)).toBe(true);
      const remaining = await readFile(agentsPath, "utf-8");
      expect(remaining).toBe("# User Notes\n\nKeep me.\n");
    });

    it("deletes AGENTS.md when only managed content existed", async () => {
      await adapter.install(await adapter.generate([ruleA]), tmp);
      await adapter.uninstall(tmp);
      expect(existsSync(join(tmp, "AGENTS.md"))).toBe(false);
    });

    it("leaves user-only AGENTS.md untouched when no markers exist", async () => {
      const agentsPath = join(tmp, "AGENTS.md");
      await writeFile(agentsPath, "# Custom Only\n", "utf-8");
      await adapter.uninstall(tmp);
      expect(await readFile(agentsPath, "utf-8")).toBe("# Custom Only\n");
    });
  });
});
