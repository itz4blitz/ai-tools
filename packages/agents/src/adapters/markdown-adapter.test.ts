import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMarkdownAdapter } from "./markdown-adapter.js";

describe("createMarkdownAdapter cross-platform parsing and frontmatter", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("emits name in frontmatter and round-trips cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-tools-agents-md-"));
    dirs.push(dir);
    const { adapter } = createMarkdownAdapter({
      id: "test-md-roundtrip",
      name: "Test MD",
      configDir: ".test-agents",
    });

    const files = await adapter.generate([
      {
        id: "reviewer",
        name: "Code Reviewer",
        description: "Reviews PRs",
        model: "claude-sonnet-4",
        tools: ["Read", "Grep"],
        instructions: "Check edge cases.",
      },
    ]);

    expect(files[0]?.content).toContain("name: Code Reviewer\n");
    await adapter.install(files, dir);

    const imported = await adapter.import(dir);
    expect(imported).toEqual([
      {
        id: "reviewer",
        name: "Code Reviewer",
        description: "Reviews PRs",
        model: "claude-sonnet-4",
        tools: ["Read", "Grep"],
        instructions: "Check edge cases.",
      },
    ]);
  });

  it("parses Windows CRLF files, frontmatter name, and inline/comma-separated tools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-tools-agents-crlf-"));
    dirs.push(dir);
    const agentsDir = join(dir, ".test-agents-crlf");
    await mkdir(agentsDir, { recursive: true });

    await writeFile(
      join(agentsDir, "inline-comma.md"),
      [
        "---",
        "name: Inline Comma Agent",
        "description: Uses comma tools",
        "tools: Read, Grep, Edit",
        "model: gpt-5",
        "---",
        "",
        "Follow instructions.\r\nLine two.",
      ].join("\r\n"),
      "utf-8",
    );

    await writeFile(
      join(agentsDir, "inline-bracket.md"),
      [
        "---",
        "name: Inline Bracket Agent",
        'tools: ["Bash", "Write"]',
        "---",
        "",
        "# Heading Title",
        "",
        "Body text.",
      ].join("\r\n"),
      "utf-8",
    );

    const { adapter } = createMarkdownAdapter({
      id: "test-md-crlf",
      name: "Test CRLF",
      configDir: ".test-agents-crlf",
    });

    const imported = await adapter.import(dir);
    const comma = imported.find((a) => a.id === "inline-comma");
    const bracket = imported.find((a) => a.id === "inline-bracket");

    expect(comma).toEqual({
      id: "inline-comma",
      name: "Inline Comma Agent",
      description: "Uses comma tools",
      tools: ["Read", "Grep", "Edit"],
      model: "gpt-5",
      instructions: "Follow instructions.\nLine two.",
    });

    expect(bracket).toEqual({
      id: "inline-bracket",
      name: "Inline Bracket Agent",
      tools: ["Bash", "Write"],
      instructions: "Body text.",
    });
  });
});
