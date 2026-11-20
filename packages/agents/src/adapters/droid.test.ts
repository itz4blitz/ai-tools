import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../types/index.js";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { DroidAgentAdapter } from "./droid.js";

describe("DroidAgentAdapter", () => {
  let adapter: DroidAgentAdapter;
  let tmp: string;

  const testAgent: AgentDefinition = {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews code for quality and security",
    tools: ["Read", "Execute"],
    model: "claude-sonnet-4-20250514",
    instructions: "Review carefully and report bugs.",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new DroidAgentAdapter();
    tmp = await mkdtemp(join(tmpdir(), "ai-tools-droid-agents-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has standardized Factory Droid metadata", () => {
      expect(adapter.id).toBe("droid");
      expect(adapter.name).toBe("Factory Droid");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".factory/droids");
      expect(adapter.command).toBe("droid");
    });
  });

  describe("generate & install", () => {
    it("returns empty array for no agents", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });

    it("generates .factory/droids/<id>.md with name in frontmatter", async () => {
      const files = await adapter.generate([testAgent]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".factory/droids/reviewer.md");
      expect(files[0]!.format).toBe("md");
      expect(files[0]!.content).toContain("---\nname: Code Reviewer\n");
      expect(files[0]!.content).toContain("description: Reviews code for quality and security\n");
      expect(files[0]!.content).toContain("tools:\n  - Read\n  - Execute\n");
      expect(files[0]!.content).toContain("model: claude-sonnet-4-20250514\n");
      expect(files[0]!.content).toContain("# Code Reviewer\n\nReview carefully and report bugs.\n");
    });

    it("installs and round-trips agents from a real temp directory", async () => {
      const files = await adapter.generate([testAgent]);
      await adapter.install(files, tmp);

      const diskPath = join(tmp, ".factory", "droids", "reviewer.md");
      expect(existsSync(diskPath)).toBe(true);
      const raw = await readFile(diskPath, "utf-8");
      expect(raw).toContain("name: Code Reviewer");

      const imported = await adapter.import(tmp);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toEqual(testAgent);
    });
  });

  describe("import", () => {
    it("returns empty array when .factory/droids does not exist", async () => {
      expect(await adapter.import(tmp)).toEqual([]);
    });

    it("parses CRLF files, quoted frontmatter values, and inline tools arrays", async () => {
      const droidsDir = join(tmp, ".factory", "droids");
      await mkdir(droidsDir, { recursive: true });
      await writeFile(
        join(droidsDir, "auditor.md"),
        '---\r\nname: "Security Auditor"\r\ndescription: \'Audits PRs\'\r\ntools: ["Read", "Grep"]\r\nmodel: gpt-5\r\n---\r\n\r\n# Ignored Heading\r\n\r\nCheck for vulnerabilities.\r\n',
        "utf-8",
      );
      await writeFile(join(droidsDir, "notes.txt"), "skip me", "utf-8");

      const agents = await adapter.import(tmp);
      expect(agents).toHaveLength(1);
      expect(agents[0]).toEqual({
        id: "auditor",
        name: "Security Auditor",
        description: "Audits PRs",
        tools: ["Read", "Grep"],
        model: "gpt-5",
        instructions: "Check for vulnerabilities.",
      });
    });

    it("falls back to markdown heading when frontmatter omits name", async () => {
      const droidsDir = join(tmp, ".factory", "droids");
      await mkdir(droidsDir, { recursive: true });
      await writeFile(
        join(droidsDir, "helper.md"),
        "---\ndescription: Helps out\n---\n\n# Helpful Droid\n\nAssist the user.\n",
        "utf-8",
      );

      const agents = await adapter.import(tmp);
      expect(agents).toHaveLength(1);
      expect(agents[0]!.name).toBe("Helpful Droid");
      expect(agents[0]!.description).toBe("Helps out");
      expect(agents[0]!.instructions).toBe("Assist the user.");
    });
  });

  describe("uninstall", () => {
    it("removes .factory/droids directory cleanly", async () => {
      await adapter.install(await adapter.generate([testAgent]), tmp);
      const droidsDir = join(tmp, ".factory", "droids");
      expect(existsSync(droidsDir)).toBe(true);

      await adapter.uninstall(tmp);
      expect(existsSync(droidsDir)).toBe(false);
    });

    it("does not throw when .factory/droids does not exist", async () => {
      await expect(adapter.uninstall(tmp)).resolves.toBeUndefined();
    });
  });
});
