import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockHome = vi.hoisted(() => ({ dir: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockHome.dir || actual.homedir(),
  };
});

import { GrokSessionAdapter } from "./grok.js";

describe("GrokSessionAdapter", () => {
  let adapter: GrokSessionAdapter;
  let projectDir: string;
  let fakeHome: string;
  let previousCwd: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new GrokSessionAdapter();
    projectDir = await mkdtemp(join(tmpdir(), "grok-sessions-proj-"));
    fakeHome = await mkdtemp(join(tmpdir(), "grok-sessions-home-"));
    mockHome.dir = fakeHome;
    previousCwd = process.cwd();
    process.chdir(projectDir);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    mockHome.dir = "";
    await rm(projectDir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("has correct id, name, command, and storagePaths", () => {
    expect(adapter.id).toBe("grok");
    expect(adapter.name).toBe("Grok");
    expect(adapter.command).toBe("grok");
    expect(adapter.storagePaths).toEqual([".grok/sessions", "~/.grok/sessions"]);
  });

  it("returns empty array when no session storage directories exist", async () => {
    expect(await adapter.parseSessions()).toEqual([]);
  });

  it("scans both project .grok/sessions and user ~/.grok/sessions for JSONL and JSON files", async () => {
    await mkdir(join(projectDir, ".grok/sessions"), { recursive: true });
    await mkdir(join(fakeHome, ".grok/sessions"), { recursive: true });

    await writeFile(
      join(projectDir, ".grok/sessions/proj-chat.jsonl"),
      [
        JSON.stringify({
          role: "user",
          content: "Refactor auth middleware",
          timestamp: "2026-01-01T10:00:00Z",
        }),
        JSON.stringify({
          role: "assistant",
          content: "I will split token validation into a helper.",
        }),
        JSON.stringify({ role: "unknown", content: "ignored" }),
      ].join("\n") + "\n",
      "utf-8",
    );

    await writeFile(
      join(fakeHome, ".grok/sessions/user-chat.json"),
      JSON.stringify({
        id: "grok-user-1",
        title: "Debug build pipeline",
        projectPath: "/workspace/app",
        createdAt: "2026-01-02T09:00:00Z",
        updatedAt: "2026-01-02T10:00:00Z",
        messages: [
          { type: "human", content: [{ type: "text", text: "Why does the build fail?" }] },
          { role: "model", text: "Missing tsconfig path alias." },
        ],
      }),
      "utf-8",
    );

    // Malformed and non-session files should be skipped gracefully
    await writeFile(join(projectDir, ".grok/sessions/broken.json"), "{not-json", "utf-8");
    await writeFile(join(projectDir, ".grok/sessions/readme.txt"), "ignore", "utf-8");

    const sessions = await adapter.parseSessions();
    expect(sessions).toHaveLength(2);

    const byId = new Map(sessions.map((s) => [s.id, s]));
    const proj = byId.get("grok-proj-chat");
    expect(proj).toBeDefined();
    expect(proj?.tool).toBe("grok");
    expect(proj?.toolName).toBe("Grok");
    expect(proj?.title).toBe("Refactor auth middleware");
    expect(proj?.messageCount).toBe(2);
    expect(proj?.messages[0]?.role).toBe("user");
    expect(proj?.messages[1]?.role).toBe("assistant");

    const user = byId.get("grok-user-1");
    expect(user).toBeDefined();
    expect(user?.title).toBe("Debug build pipeline");
    expect(user?.projectPath).toBe("/workspace/app");
    expect(user?.messageCount).toBe(2);
    expect(user?.messages[0]).toEqual({ role: "user", content: "Why does the build fail?" });
    expect(user?.messages[1]).toEqual({
      role: "assistant",
      content: "Missing tsconfig path alias.",
    });
  });

  it("applies SessionFilter when provided", async () => {
    await mkdir(join(projectDir, ".grok/sessions"), { recursive: true });
    await writeFile(
      join(projectDir, ".grok/sessions/a.jsonl"),
      `${JSON.stringify({ role: "user", content: "First" })}\n`,
      "utf-8",
    );
    await writeFile(
      join(projectDir, ".grok/sessions/b.jsonl"),
      `${JSON.stringify({ role: "user", content: "Second" })}\n`,
      "utf-8",
    );

    const limited = await adapter.parseSessions({ limit: 1 });
    expect(limited).toHaveLength(1);
  });
});
