import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockHome } = vi.hoisted(() => ({
  mockHome: { current: "" },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHome.current || actual.homedir(),
  };
});

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { CursorAgentAdapter, type CursorAgentDefinition } from "./cursor.js";

describe("CursorAgentAdapter", () => {
  let adapter: CursorAgentAdapter;
  let tempDir: string;
  let tempHome: string;

  const testAgent: CursorAgentDefinition = {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews code for quality",
    instructions: "Review all code changes carefully.",
    model: "claude-4-sonnet",
    readonly: true,
    isBackground: false,
    tools: ["Read", "Grep"],
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-agents-cursor-"));
    tempHome = await mkdtemp(join(tmpdir(), "ai-tools-agents-cursor-home-"));
    mockHome.current = tempHome;
    adapter = new CursorAgentAdapter();
  });

  afterEach(async () => {
    mockHome.current = "";
    await rm(tempDir, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
  });

  describe("metadata", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("cursor");
      expect(adapter.name).toBe("Cursor");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".cursor/agents");
    });
  });

  describe("generate", () => {
    it("returns empty array for no agents", async () => {
      expect(await adapter.generate([])).toEqual([]);
    });

    it("generates Cursor subagent frontmatter including name, description, model, readonly, is_background", async () => {
      const files = await adapter.generate([testAgent]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".cursor/agents/reviewer.md");
      expect(files[0]!.format).toBe("md");
      expect(files[0]!.content).toContain("name: Code Reviewer");
      expect(files[0]!.content).toContain("description: Reviews code for quality");
      expect(files[0]!.content).toContain("model: claude-4-sonnet");
      expect(files[0]!.content).toContain("readonly: true");
      expect(files[0]!.content).toContain("is_background: false");
      expect(files[0]!.content).toContain("# Code Reviewer");
      expect(files[0]!.content).toContain("Review all code changes carefully.");
    });

    it("generates user-layer paths under ~/.cursor/agents/", async () => {
      const files = await adapter.generate([testAgent], "user");
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(join(tempHome, ".cursor", "agents", "reviewer.md"));
    });
  });

  describe("install, import, importUser, detect, uninstall", () => {
    it("round-trips project agents with Cursor subagent frontmatter", async () => {
      const files = await adapter.generate([testAgent]);
      await adapter.install(files, tempDir);

      expect(existsSync(join(tempDir, ".cursor/agents/reviewer.md"))).toBe(true);
      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toMatchObject({
        id: "reviewer",
        name: "Code Reviewer",
        description: "Reviews code for quality",
        model: "claude-4-sonnet",
        readonly: true,
        isBackground: false,
        tools: ["Read", "Grep"],
        instructions: "Review all code changes carefully.",
      });
    });

    it("parses CRLF frontmatter cleanly", async () => {
      await mkdir(join(tempDir, ".cursor/agents"), { recursive: true });
      await writeFile(
        join(tempDir, ".cursor/agents/bg.md"),
        "---\r\nname: Background Runner\r\ndescription: Runs tasks\r\nmodel: fast\r\nreadonly: true\r\nis_background: true\r\n---\r\n\r\nRun in background.\r\n",
        "utf-8",
      );

      const imported = await adapter.import(tempDir);
      expect(imported).toHaveLength(1);
      expect(imported[0]).toMatchObject({
        id: "bg",
        name: "Background Runner",
        description: "Runs tasks",
        model: "fast",
        readonly: true,
        isBackground: true,
        instructions: "Run in background.",
      });
    });

    it("supports user-layer install, importUser, detect, and uninstall", async () => {
      const files = await adapter.generate([testAgent], "user");
      await adapter.install(files, tempDir);

      const userFile = join(tempHome, ".cursor", "agents", "reviewer.md");
      expect(existsSync(userFile)).toBe(true);
      expect(await readFile(userFile, "utf-8")).toContain("readonly: true");
      expect(await adapter.detect(tempDir)).toBe(true);

      const userAgents = await adapter.importUser();
      expect(userAgents).toHaveLength(1);
      expect(userAgents[0]!.id).toBe("reviewer");

      await adapter.uninstall(tempDir, "user");
      expect(existsSync(join(tempHome, ".cursor", "agents"))).toBe(false);
    });

    it("uninstalls project-layer .cursor/agents cleanly", async () => {
      const files = await adapter.generate([testAgent]);
      await adapter.install(files, tempDir);
      expect(existsSync(join(tempDir, ".cursor/agents"))).toBe(true);

      await adapter.uninstall(tempDir);
      expect(existsSync(join(tempDir, ".cursor/agents"))).toBe(false);
    });
  });
});
