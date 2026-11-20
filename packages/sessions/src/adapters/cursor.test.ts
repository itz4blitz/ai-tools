import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

import { CursorSessionAdapter } from "./cursor.js";

describe("CursorSessionAdapter", () => {
  let adapter: CursorSessionAdapter;
  let tempHome: string;
  const origAppData = process.env.APPDATA;
  const origXdg = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "ai-tools-sessions-cursor-"));
    mockHome.current = tempHome;
    process.env.APPDATA = join(tempHome, "AppData", "Roaming");
    process.env.XDG_CONFIG_HOME = join(tempHome, ".config");
    adapter = new CursorSessionAdapter();
  });

  afterEach(async () => {
    mockHome.current = "";
    if (origAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = origAppData;
    }
    if (origXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdg;
    }
    await rm(tempHome, { recursive: true, force: true });
  });

  describe("properties", () => {
    it("has correct id, name, command, and storagePaths", () => {
      expect(adapter.id).toBe("cursor");
      expect(adapter.name).toBe("Cursor");
      expect(adapter.command).toBe("cursor");
      expect(adapter.storagePaths).toEqual(["~/.cursor"]);
    });
  });

  describe("parseSessions()", () => {
    it("returns empty array when ~/.cursor does not exist", async () => {
      const sessions = await adapter.parseSessions();
      expect(sessions).toEqual([]);
    });

    it("scans ~/.cursor/projects/*/agent-transcripts/*.jsonl including content block arrays", async () => {
      const transcriptsDir = join(
        tempHome,
        ".cursor",
        "projects",
        "Users-dev-myapp",
        "agent-transcripts",
      );
      await mkdir(transcriptsDir, { recursive: true });
      await writeFile(
        join(transcriptsDir, "transcript-abc.jsonl"),
        [
          JSON.stringify({
            role: "user",
            message: { content: [{ type: "text", text: "Fix the login bug" }] },
            cwd: "/Users/dev/myapp",
          }),
          JSON.stringify({
            role: "assistant",
            message: {
              content: [
                { type: "text", text: "I'll inspect the auth handler." },
                { type: "text", text: "Found the issue in login.ts." },
              ],
            },
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("cursor-transcript-abc");
      expect(sessions[0]?.tool).toBe("cursor");
      expect(sessions[0]?.projectPath).toBe("/Users/dev/myapp");
      expect(sessions[0]?.title).toBe("Fix the login bug");
      expect(sessions[0]?.messages).toHaveLength(2);
      expect(sessions[0]?.messages[0]?.role).toBe("user");
      expect(sessions[0]?.messages[0]?.content).toBe("Fix the login bug");
      expect(sessions[0]?.messages[1]?.content).toContain("Found the issue in login.ts.");
    });

    it("scans nested agent-transcripts/<id>/<id>.jsonl directories", async () => {
      const nestedDir = join(
        tempHome,
        ".cursor",
        "projects",
        "workspace-one",
        "agent-transcripts",
        "sess-42",
      );
      await mkdir(nestedDir, { recursive: true });
      await writeFile(
        join(nestedDir, "sess-42.jsonl"),
        '{"role":"user","content":"Nested transcript message"}\n{"role":"assistant","content":"Handled"}\n',
        "utf-8",
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("cursor-sess-42");
      expect(sessions[0]?.projectPath).toBe("workspace-one");
      expect(sessions[0]?.messages).toHaveLength(2);
    });

    it("also parses legacy flat ~/.cursor/*.jsonl and *.json files", async () => {
      const cursorDir = join(tempHome, ".cursor");
      await mkdir(cursorDir, { recursive: true });
      await writeFile(
        join(cursorDir, "chat.jsonl"),
        '{"role":"user","content":"Fix this"}\n{"role":"assistant","content":"On it"}\n',
        "utf-8",
      );
      await writeFile(
        join(cursorDir, "session.json"),
        JSON.stringify({
          id: "cur-123",
          title: "Refactor Session",
          messages: [
            { role: "user", content: "Refactor this module" },
            { role: "assistant", content: "Starting refactor" },
          ],
        }),
        "utf-8",
      );
      await writeFile(join(cursorDir, "config.yaml"), "ignored: true", "utf-8");

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(2);
      const ids = sessions.map((s) => s.id).toSorted();
      expect(ids).toEqual(["cur-123", "cursor-chat"]);
    });

    it("skips entries with unknown roles and malformed lines", async () => {
      const cursorDir = join(tempHome, ".cursor");
      await mkdir(cursorDir, { recursive: true });
      await writeFile(
        join(cursorDir, "mixed.jsonl"),
        'not json\n{"role":"unknown","content":"skip"}\n{"role":"user","content":"keep"}\n',
        "utf-8",
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.messages).toHaveLength(1);
      expect(sessions[0]?.messages[0]?.content).toBe("keep");
    });

    it("falls back gracefully if state.vscdb is corrupt", async () => {
      const dbDir =
        process.platform === "win32"
          ? join(tempHome, "AppData", "Roaming", "Cursor", "User", "globalStorage")
          : process.platform === "darwin"
            ? join(tempHome, "Library", "Application Support", "Cursor", "User", "globalStorage")
            : join(tempHome, ".config", "Cursor", "User", "globalStorage");
      await mkdir(dbDir, { recursive: true });
      await writeFile(join(dbDir, "state.vscdb"), "not a valid sqlite database", "utf-8");

      const sessions = await adapter.parseSessions();
      expect(sessions).toEqual([]);
    });

    it("supports limit filter", async () => {
      const transcriptsDir = join(tempHome, ".cursor", "projects", "proj", "agent-transcripts");
      await mkdir(transcriptsDir, { recursive: true });
      await writeFile(join(transcriptsDir, "a.jsonl"), '{"role":"user","content":"First"}\n');
      await writeFile(join(transcriptsDir, "b.jsonl"), '{"role":"user","content":"Second"}\n');

      const sessions = await adapter.parseSessions({ limit: 1 });
      expect(sessions).toHaveLength(1);
    });
  });
});
