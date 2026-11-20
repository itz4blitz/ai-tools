import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCodeSessionAdapter } from "./opencode.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-sessions-opencode-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("OpenCodeSessionAdapter", () => {
  let adapter: OpenCodeSessionAdapter;
  const origOpenCodeData = process.env.OPENCODE_DATA;
  const origXdgDataHome = process.env.XDG_DATA_HOME;

  beforeEach(() => {
    delete process.env.OPENCODE_DATA;
    delete process.env.XDG_DATA_HOME;
    adapter = new OpenCodeSessionAdapter();
  });

  afterEach(() => {
    if (origOpenCodeData !== undefined) process.env.OPENCODE_DATA = origOpenCodeData;
    else delete process.env.OPENCODE_DATA;
    if (origXdgDataHome !== undefined) process.env.XDG_DATA_HOME = origXdgDataHome;
    else delete process.env.XDG_DATA_HOME;
  });

  describe("properties & storage path resolution", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("opencode");
      expect(adapter.name).toBe("OpenCode");
      expect(adapter.command).toBe("opencode");
    });

    it("prioritizes OPENCODE_DATA and XDG_DATA_HOME/opencode in storagePaths", () => {
      process.env.OPENCODE_DATA = join(tmpdir(), "custom-oc-data");
      process.env.XDG_DATA_HOME = join(tmpdir(), "xdg-data");

      const paths = adapter.storagePaths;
      expect(paths[0]).toBe(resolve(join(tmpdir(), "custom-oc-data")));
      expect(paths[1]).toBe(join(tmpdir(), "xdg-data", "opencode"));
    });
  });

  describe("parseSessions() - v2 SQLite (opencode.db)", () => {
    it("reads sessions, messages, and text parts from opencode.db", async () => {
      await withTempDir(async (dir) => {
        process.env.OPENCODE_DATA = dir;

        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(join(dir, "opencode.db"));
        try {
          db.exec(`
            CREATE TABLE session (
              id TEXT PRIMARY KEY,
              title TEXT,
              directory TEXT,
              time_created INTEGER,
              time_updated INTEGER
            );
            CREATE TABLE message (
              id TEXT PRIMARY KEY,
              session_id TEXT,
              time_created INTEGER,
              data TEXT
            );
            CREATE TABLE part (
              id TEXT PRIMARY KEY,
              message_id TEXT,
              session_id TEXT,
              time_created INTEGER,
              data TEXT
            );
          `);

          db.prepare(
            "INSERT INTO session (id, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
          ).run("ses_v2_1", "Fix SQLite Reader", "/repo/app", 1735689600000, 1735693200000);

          db.prepare(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
          ).run(
            "msg_1",
            "ses_v2_1",
            1735689601000,
            JSON.stringify({ role: "user", time: { created: 1735689601000 } }),
          );
          db.prepare(
            "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
          ).run(
            "msg_2",
            "ses_v2_1",
            1735689605000,
            JSON.stringify({ role: "assistant", time: { created: 1735689605000 } }),
          );

          db.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
          ).run(
            "prt_1",
            "msg_1",
            "ses_v2_1",
            1735689601000,
            JSON.stringify({ type: "text", text: "Help me read opencode.db" }),
          );
          db.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
          ).run(
            "prt_2",
            "msg_2",
            "ses_v2_1",
            1735689605000,
            JSON.stringify({ type: "text", text: "Use node:sqlite DatabaseSync." }),
          );
        } finally {
          db.close();
        }

        const sessions = await adapter.parseSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
          id: "ses_v2_1",
          tool: "opencode",
          toolName: "OpenCode",
          title: "Fix SQLite Reader",
          projectPath: "/repo/app",
          messageCount: 2,
        });
        expect(sessions[0]!.messages[0]).toMatchObject({
          role: "user",
          content: "Help me read opencode.db",
        });
        expect(sessions[0]!.messages[1]).toMatchObject({
          role: "assistant",
          content: "Use node:sqlite DatabaseSync.",
        });
      });
    });
  });

  describe("parseSessions() - v1 storage/ tree", () => {
    it("reads sessions from storage/session, storage/message, and storage/part", async () => {
      await withTempDir(async (dir) => {
        process.env.OPENCODE_DATA = dir;

        await mkdir(join(dir, "storage", "session", "proj_1"), { recursive: true });
        await mkdir(join(dir, "storage", "message", "ses_v1_1"), { recursive: true });
        await mkdir(join(dir, "storage", "part", "msg_a"), { recursive: true });
        await mkdir(join(dir, "storage", "part", "msg_b"), { recursive: true });

        await writeFile(
          join(dir, "storage", "session", "proj_1", "ses_v1_1.json"),
          JSON.stringify({
            id: "ses_v1_1",
            title: "V1 Storage Session",
            directory: "/repo/v1",
            time: { created: 1735689600000, updated: 1735690000000 },
          }),
        );

        await writeFile(
          join(dir, "storage", "message", "ses_v1_1", "msg_a.json"),
          JSON.stringify({
            id: "msg_a",
            sessionID: "ses_v1_1",
            role: "user",
            time: { created: 1735689601000 },
          }),
        );

        await writeFile(
          join(dir, "storage", "message", "ses_v1_1", "msg_b.json"),
          JSON.stringify({
            id: "msg_b",
            sessionID: "ses_v1_1",
            role: "assistant",
            time: { created: 1735689602000 },
          }),
        );

        await writeFile(
          join(dir, "storage", "part", "msg_a", "part_1.json"),
          JSON.stringify({ id: "part_1", messageID: "msg_a", type: "text", text: "Hello v1" }),
        );
        await writeFile(
          join(dir, "storage", "part", "msg_b", "part_2.json"),
          JSON.stringify({ id: "part_2", messageID: "msg_b", type: "text", text: "Hi from v1" }),
        );

        const sessions = await adapter.parseSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
          id: "ses_v1_1",
          title: "V1 Storage Session",
          projectPath: "/repo/v1",
          messageCount: 2,
        });
        expect(sessions[0]!.messages.map((m) => m.content)).toEqual(["Hello v1", "Hi from v1"]);
      });
    });
  });

  describe("parseSessions() - legacy JSON fallback", () => {
    it("parses flat JSON files when neither opencode.db nor storage/ exists", async () => {
      await withTempDir(async (dir) => {
        process.env.OPENCODE_DATA = dir;
        await writeFile(
          join(dir, "legacy-session.json"),
          JSON.stringify({
            id: "oc-legacy",
            title: "Legacy Debug",
            path: "/home/user/project",
            messages: [
              { role: "user", content: "What is this bug?" },
              { role: "assistant", text: "Null reference." },
            ],
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T01:00:00Z",
          }),
        );

        const sessions = await adapter.parseSessions();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]!.id).toBe("oc-legacy");
        expect(sessions[0]!.messages).toHaveLength(2);
      });
    });

    it("returns empty array when data dir is empty", async () => {
      await withTempDir(async (dir) => {
        process.env.OPENCODE_DATA = dir;
        expect(await adapter.parseSessions()).toEqual([]);
      });
    });
  });
});
