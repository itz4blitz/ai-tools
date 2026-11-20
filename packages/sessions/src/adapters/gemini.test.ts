import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiSessionAdapter } from "./gemini.js";

describe("GeminiSessionAdapter", () => {
  let adapter: GeminiSessionAdapter;
  let tempGeminiDir: string;

  beforeEach(async () => {
    tempGeminiDir = await mkdtemp(join(tmpdir(), "ai-tools-gemini-sessions-"));
    adapter = new GeminiSessionAdapter();
    vi.spyOn(adapter, "getStoragePath").mockResolvedValue(tempGeminiDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempGeminiDir, { recursive: true, force: true });
  });

  describe("properties", () => {
    it("has correct id, name, command, and storagePaths", () => {
      expect(adapter.id).toBe("gemini");
      expect(adapter.name).toBe("Gemini CLI");
      expect(adapter.command).toBe("gemini");
      expect(adapter.storagePaths).toEqual(["~/.gemini"]);
    });
  });

  describe("parseSessions()", () => {
    it("returns empty array when storage path does not exist", async () => {
      vi.spyOn(adapter, "getStoragePath").mockResolvedValue(null);
      const sessions = await adapter.parseSessions();
      expect(sessions).toEqual([]);
    });

    it("parses JSON sessions under ~/.gemini/tmp/<hash>/chats/session-*.json", async () => {
      const chatsDir = join(tempGeminiDir, "tmp", "proj-abc123", "chats");
      await mkdir(chatsDir, { recursive: true });
      await writeFile(
        join(chatsDir, "session-2026-01-01T10-00-abc.json"),
        JSON.stringify({
          sessionId: "sess-json-1",
          projectHash: "proj-abc123",
          startTime: "2026-01-01T10:00:00Z",
          lastUpdated: "2026-01-01T10:30:00Z",
          messages: [
            { type: "user", content: "Explain the build error", timestamp: "2026-01-01T10:00:01Z" },
            {
              type: "gemini",
              content: [{ text: "The error is caused by" }, { text: "a missing import." }],
              timestamp: "2026-01-01T10:00:05Z",
            },
          ],
        }),
        "utf-8",
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("sess-json-1");
      expect(sessions[0]?.tool).toBe("gemini");
      expect(sessions[0]?.startedAt).toBe("2026-01-01T10:00:00Z");
      expect(sessions[0]?.updatedAt).toBe("2026-01-01T10:30:00Z");
      expect(sessions[0]?.metadata).toEqual({ projectHash: "proj-abc123" });
      expect(sessions[0]?.messages).toEqual([
        { role: "user", content: "Explain the build error", timestamp: "2026-01-01T10:00:01Z" },
        {
          role: "assistant",
          content: "The error is caused by\na missing import.",
          timestamp: "2026-01-01T10:00:05Z",
        },
      ]);
    });

    it("parses JSONL sessions under ~/.gemini/tmp/<hash>/chats/session-*.jsonl", async () => {
      const chatsDir = join(tempGeminiDir, "tmp", "proj-jsonl", "chats");
      await mkdir(chatsDir, { recursive: true });
      const lines = [
        JSON.stringify({
          type: "session_metadata",
          sessionId: "sess-jsonl-1",
          projectHash: "proj-jsonl",
          title: "Refactor Adapter",
          startTime: "2026-02-01T08:00:00Z",
          lastUpdated: "2026-02-01T08:05:00Z",
        }),
        JSON.stringify({
          type: "user",
          content: "Refactor the hooks adapter",
          timestamp: "2026-02-01T08:01:00Z",
        }),
        "not valid json line",
        JSON.stringify({
          type: "gemini",
          content: "Refactored hooks adapter cleanly.",
          timestamp: "2026-02-01T08:10:00Z",
        }),
      ];
      await writeFile(
        join(chatsDir, "session-2026-02-01T08-00-xyz.jsonl"),
        `${lines.join("\n")}\n`,
        "utf-8",
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("sess-jsonl-1");
      expect(sessions[0]?.title).toBe("Refactor Adapter");
      expect(sessions[0]?.startedAt).toBe("2026-02-01T08:00:00Z");
      expect(sessions[0]?.updatedAt).toBe("2026-02-01T08:10:00Z");
      expect(sessions[0]?.metadata).toEqual({ projectHash: "proj-jsonl" });
      expect(sessions[0]?.messages).toHaveLength(2);
      expect(sessions[0]?.messages[0]?.role).toBe("user");
      expect(sessions[0]?.messages[1]?.role).toBe("assistant");
    });

    it("keeps fallback for legacy flat JSON files and ignores non-session settings.json", async () => {
      await writeFile(
        join(tempGeminiDir, "settings.json"),
        JSON.stringify({ theme: "Default" }),
        "utf-8",
      );
      await writeFile(
        join(tempGeminiDir, "legacy-chat.json"),
        JSON.stringify({
          id: "legacy-1",
          title: "Legacy Chat",
          history: [
            { role: "user", parts: [{ text: "Part 1" }, { text: "Part 2" }] },
            { role: "model", content: "Answer" },
          ],
          createTime: "2025-01-01T00:00:00Z",
          updateTime: "2025-01-01T01:00:00Z",
        }),
        "utf-8",
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("legacy-1");
      expect(sessions[0]?.messages[0]?.content).toBe("Part 1\nPart 2");
      expect(sessions[0]?.messages[1]?.role).toBe("assistant");
    });

    it("sorts sessions by updatedAt descending across JSON, JSONL, and legacy", async () => {
      const chatsDir = join(tempGeminiDir, "tmp", "p1", "chats");
      await mkdir(chatsDir, { recursive: true });
      await writeFile(
        join(chatsDir, "session-old.json"),
        JSON.stringify({
          sessionId: "older",
          startTime: "2026-01-01T00:00:00Z",
          lastUpdated: "2026-01-01T01:00:00Z",
          messages: [{ type: "user", content: "Old" }],
        }),
        "utf-8",
      );
      await writeFile(
        join(chatsDir, "session-new.jsonl"),
        `${JSON.stringify({
          type: "session_metadata",
          sessionId: "newer",
          startTime: "2026-03-01T00:00:00Z",
          lastUpdated: "2026-03-01T02:00:00Z",
        })}\n${JSON.stringify({
          type: "user",
          content: "New",
          timestamp: "2026-03-01T02:00:00Z",
        })}\n`,
        "utf-8",
      );

      const sessions = await adapter.parseSessions({ limit: 1 });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("newer");
    });
  });
});
