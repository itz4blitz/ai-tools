import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexSessionAdapter } from "./codex.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-sessions-codex-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("CodexSessionAdapter", () => {
  let adapter: CodexSessionAdapter;
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    adapter = new CodexSessionAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  });

  describe("properties", () => {
    it("has correct id, name, command, and storagePaths", () => {
      expect(adapter.id).toBe("codex");
      expect(adapter.name).toBe("Codex");
      expect(adapter.command).toBe("codex");
      expect(adapter.storagePaths).toEqual(["~/.codex/sessions"]);
    });
  });

  describe("getStoragePath()", () => {
    it("resolves $CODEX_HOME/sessions when CODEX_HOME is set", async () => {
      await withTempDir(async (dir) => {
        const sessionsDir = join(dir, "sessions");
        await mkdir(sessionsDir, { recursive: true });
        process.env.CODEX_HOME = dir;

        expect(await adapter.getStoragePath()).toBe(sessionsDir);
      });
    });

    it("returns null when $CODEX_HOME/sessions does not exist", async () => {
      await withTempDir(async (dir) => {
        process.env.CODEX_HOME = dir;
        expect(await adapter.getStoragePath()).toBeNull();
      });
    });
  });

  describe("parseSessions()", () => {
    it("returns empty array when storage path does not exist", async () => {
      await withTempDir(async (dir) => {
        process.env.CODEX_HOME = join(dir, "missing-codex-home");
        expect(await adapter.parseSessions()).toEqual([]);
      });
    });

    it("recursively scans YYYY/MM/DD/rollout-*.jsonl and parses session_meta and response_item without double-counting event_msg", async () => {
      await withTempDir(async (dir) => {
        process.env.CODEX_HOME = dir;
        const rolloutDir = join(dir, "sessions", "2026", "04", "15");
        await mkdir(rolloutDir, { recursive: true });

        const lines = [
          JSON.stringify({
            timestamp: "2026-04-15T10:00:00.000Z",
            type: "session_meta",
            payload: {
              id: "019d8f00-1234-7000-8000-abcdef123456",
              timestamp: "2026-04-15T10:00:00.000Z",
              cwd: "/workspace/my-app",
            },
          }),
          // Duplicate event_msg that must NOT be double-counted
          JSON.stringify({
            timestamp: "2026-04-15T10:00:01.000Z",
            type: "event_msg",
            payload: {
              type: "user_message",
              message: "Fix the failing build",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-15T10:00:01.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Fix the failing build" }],
            },
          }),
          // Non-message response_item (e.g. function_call) should be ignored
          JSON.stringify({
            timestamp: "2026-04-15T10:00:02.000Z",
            type: "response_item",
            payload: {
              type: "function_call",
              name: "exec_command",
              arguments: '{"cmd":"npm test"}',
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-15T10:00:03.000Z",
            type: "event_msg",
            payload: {
              type: "agent_message",
              message: "I will check the build error.",
            },
          }),
          JSON.stringify({
            timestamp: "2026-04-15T10:00:03.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "I will check the build error." },
                { type: "output_text", text: "Tests pass now." },
              ],
            },
          }),
          // String content format
          JSON.stringify({
            timestamp: "2026-04-15T10:00:05.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: "Thanks!",
            },
          }),
        ];

        await writeFile(
          join(rolloutDir, "rollout-2026-04-15T10-00-00-019d8f00.jsonl"),
          lines.join("\n") + "\n",
          "utf-8",
        );

        // Non-rollout files should be ignored
        await writeFile(join(rolloutDir, "notes.jsonl"), '{"type":"response_item"}\n', "utf-8");
        await writeFile(join(rolloutDir, "readme.md"), "# ignore\n", "utf-8");

        const sessions = await adapter.parseSessions();
        expect(sessions).toHaveLength(1);

        const session = sessions[0]!;
        expect(session.id).toBe("codex-019d8f00-1234-7000-8000-abcdef123456");
        expect(session.projectPath).toBe("/workspace/my-app");
        expect(session.startedAt).toBe("2026-04-15T10:00:00.000Z");
        expect(session.updatedAt).toBe("2026-04-15T10:00:05.000Z");
        expect(session.title).toBe("Fix the failing build");
        expect(session.messageCount).toBe(3);
        expect(session.messages).toEqual([
          {
            role: "user",
            content: "Fix the failing build",
            timestamp: "2026-04-15T10:00:01.000Z",
          },
          {
            role: "assistant",
            content: "I will check the build error.\nTests pass now.",
            timestamp: "2026-04-15T10:00:03.000Z",
          },
          {
            role: "user",
            content: "Thanks!",
            timestamp: "2026-04-15T10:00:05.000Z",
          },
        ]);
      });
    });

    it("supports filtering by projectPath and sorts newest first", async () => {
      await withTempDir(async (dir) => {
        process.env.CODEX_HOME = dir;
        const day1 = join(dir, "sessions", "2026", "04", "10");
        const day2 = join(dir, "sessions", "2026", "04", "12");
        await mkdir(day1, { recursive: true });
        await mkdir(day2, { recursive: true });

        await writeFile(
          join(day1, "rollout-older.jsonl"),
          [
            JSON.stringify({
              type: "session_meta",
              payload: { id: "old", cwd: "/proj/a", timestamp: "2026-04-10T09:00:00.000Z" },
            }),
            JSON.stringify({
              timestamp: "2026-04-10T09:01:00.000Z",
              type: "response_item",
              payload: { type: "message", role: "user", content: "Old prompt" },
            }),
          ].join("\n"),
          "utf-8",
        );

        await writeFile(
          join(day2, "rollout-newer.jsonl"),
          [
            JSON.stringify({
              type: "session_meta",
              payload: { id: "new", cwd: "/proj/b", timestamp: "2026-04-12T12:00:00.000Z" },
            }),
            JSON.stringify({
              timestamp: "2026-04-12T12:05:00.000Z",
              type: "response_item",
              payload: { type: "message", role: "user", content: "New prompt" },
            }),
          ].join("\n"),
          "utf-8",
        );

        const all = await adapter.parseSessions();
        expect(all.map((s) => s.id)).toEqual(["codex-new", "codex-old"]);

        const filtered = await adapter.parseSessions({ projectPath: "/proj/a" });
        expect(filtered).toHaveLength(1);
        expect(filtered[0]?.id).toBe("codex-old");
      });
    });

    it("skips rollout files with malformed lines, unknown roles, or no messages", async () => {
      await withTempDir(async (dir) => {
        process.env.CODEX_HOME = dir;
        const rolloutDir = join(dir, "sessions", "2026", "04", "16");
        await mkdir(rolloutDir, { recursive: true });

        await writeFile(
          join(rolloutDir, "rollout-empty.jsonl"),
          'not-json\n{"type":"event_msg","payload":{"type":"user_message","message":"ignored"}}\n',
          "utf-8",
        );
        await writeFile(
          join(rolloutDir, "rollout-partial.jsonl"),
          [
            "corrupted line",
            JSON.stringify({
              type: "response_item",
              payload: { type: "message", role: "unknown", content: "skip me" },
            }),
            JSON.stringify({
              type: "response_item",
              payload: { type: "message", role: "developer", content: "system guidance" },
            }),
            JSON.stringify({
              type: "response_item",
              payload: { type: "message", role: "user", content: "keep me" },
            }),
          ].join("\n"),
          "utf-8",
        );

        const sessions = await adapter.parseSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]?.id).toBe("codex-rollout-partial");
        expect(sessions[0]?.messages).toHaveLength(2);
        expect(sessions[0]?.messages[0]?.role).toBe("system");
        expect(sessions[0]?.messages[1]?.content).toBe("keep me");
      });
    });
  });
});
