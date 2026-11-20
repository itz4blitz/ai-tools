import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fakeHome } = vi.hoisted(() => ({ fakeHome: { value: "" } }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => fakeHome.value || actual.homedir(),
  };
});

import { ClaudeSessionAdapter } from "./claude.js";

const temps: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ai-sessions-claude-"));
  temps.push(dir);
  fakeHome.value = dir;
  return dir;
}

describe("ClaudeSessionAdapter", () => {
  let adapter: ClaudeSessionAdapter;

  beforeEach(() => {
    adapter = new ClaudeSessionAdapter();
    fakeHome.value = "";
  });

  afterEach(async () => {
    fakeHome.value = "";
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("has correct metadata", () => {
    expect(adapter.id).toBe("claude");
    expect(adapter.name).toBe("Claude Code");
    expect(adapter.command).toBe("claude");
    expect(adapter.storagePaths).toEqual(["~/.claude/projects"]);
  });

  it("returns empty array when storage path does not exist", async () => {
    await makeTempHome();
    expect(await adapter.parseSessions()).toEqual([]);
  });

  it("parses modern 'user' and legacy 'human' entries, entry.cwd, timestamps, and tool_result blocks", async () => {
    const home = await makeTempHome();
    const projectDir = join(home, ".claude", "projects", "-Users-dev-myapp");
    await mkdir(projectDir, { recursive: true });

    const lines = [
      JSON.stringify({
        type: "user",
        cwd: "/Users/dev/myapp",
        timestamp: "2026-03-01T10:00:00.000Z",
        message: { role: "user", content: "Fix the failing build" },
      }),
      JSON.stringify({
        type: "assistant",
        cwd: "/Users/dev/myapp",
        timestamp: "2026-03-01T10:01:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Running tests now." },
            { type: "tool_use", name: "Bash", input: { command: "npm test" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        cwd: "/Users/dev/myapp",
        timestamp: "2026-03-01T10:02:00.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "All 42 tests passed" }],
        },
      }),
      JSON.stringify({
        type: "human",
        timestamp: "2026-03-01T10:05:00.000Z",
        message: { content: "Thanks!" },
      }),
    ];

    await writeFile(join(projectDir, "sess-1.jsonl"), lines.join("\n") + "\n", "utf-8");

    const sessions = await adapter.parseSessions();
    expect(sessions).toHaveLength(1);

    const session = sessions[0]!;
    expect(session.projectPath).toBe("/Users/dev/myapp");
    expect(session.startedAt).toBe("2026-03-01T10:00:00.000Z");
    expect(session.updatedAt).toBe("2026-03-01T10:05:00.000Z");
    expect(session.title).toBe("Fix the failing build");
    expect(session.messages).toHaveLength(4);
    expect(session.messages[0]).toMatchObject({
      role: "user",
      content: "Fix the failing build",
      timestamp: "2026-03-01T10:00:00.000Z",
    });
    expect(session.messages[1]).toMatchObject({
      role: "assistant",
      content: "Running tests now.",
    });
    expect(session.messages[2]).toMatchObject({
      role: "tool",
      content: "All 42 tests passed",
    });
    expect(session.messages[3]).toMatchObject({
      role: "user",
      content: "Thanks!",
    });
  });

  it("handles tool_result with array text blocks and falls back to projectDir when cwd is absent", async () => {
    const home = await makeTempHome();
    const projectDir = join(home, ".claude", "projects", "encoded-proj");
    await mkdir(projectDir, { recursive: true });

    const lines = [
      "malformed line",
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              content: [
                { type: "text", text: "line 1" },
                { type: "text", text: "line 2" },
              ],
            },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: "Done." },
      }),
    ];

    await writeFile(join(projectDir, "s2.jsonl"), lines.join("\n") + "\n", "utf-8");
    await writeFile(join(projectDir, "ignore.txt"), "not jsonl", "utf-8");

    const sessions = await adapter.parseSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.projectPath).toBe("encoded-proj");
    expect(sessions[0]!.messages[0]).toMatchObject({
      role: "tool",
      content: "line 1\nline 2",
    });
    expect(sessions[0]!.messages[1]).toMatchObject({
      role: "assistant",
      content: "Done.",
    });
  });
});
