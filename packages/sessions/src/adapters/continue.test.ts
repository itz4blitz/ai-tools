import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockHome } = vi.hoisted(() => ({ mockHome: { value: "" } }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHome.value || actual.homedir(),
  };
});

import { ContinueSessionAdapter } from "./continue.js";

describe("ContinueSessionAdapter", () => {
  let adapter: ContinueSessionAdapter;
  let home: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    home = await mkdtemp(join(tmpdir(), "continue-sessions-home-"));
    mockHome.value = home;
    adapter = new ContinueSessionAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(home, { recursive: true, force: true });
  });

  describe("properties", () => {
    it("has correct id, name, command, and storagePaths", () => {
      expect(adapter.id).toBe("continue");
      expect(adapter.name).toBe("Continue");
      expect(adapter.command).toBe("cn");
      expect(adapter.storagePaths).toEqual(["~/.continue/sessions"]);
    });
  });

  describe("parseSessions()", () => {
    it("returns empty array when ~/.continue/sessions does not exist", async () => {
      expect(await adapter.parseSessions()).toEqual([]);
    });

    it("parses Continue session JSON files and skips sessions.json index", async () => {
      const sessionsDir = join(home, ".continue/sessions");
      await mkdir(sessionsDir, { recursive: true });

      // Index file should be skipped
      await writeFile(
        join(sessionsDir, "sessions.json"),
        JSON.stringify([
          { sessionId: "sess-1", title: "Index Entry", dateCreated: "1700000000000" },
        ]),
        "utf-8",
      );

      // Standard Continue session format with nested message & content parts
      await writeFile(
        join(sessionsDir, "sess-1.json"),
        JSON.stringify({
          sessionId: "sess-1",
          title: "Fix auth middleware",
          workspaceDirectory: "/repo/app",
          dateCreated: "2026-01-10T10:00:00.000Z",
          updatedAt: "2026-01-10T11:00:00.000Z",
          history: [
            {
              message: {
                role: "user",
                content: "Why is token refresh failing?",
              },
            },
            {
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: "The expiry check is inverted." },
                  { type: "text", text: "Let's fix src/auth.ts." },
                ],
              },
            },
          ],
        }),
        "utf-8",
      );

      // Flat messages format + malformed file + non-json file
      await writeFile(
        join(sessionsDir, "sess-2.json"),
        JSON.stringify({
          messages: [
            { role: "user", content: "Add unit tests" },
            { role: "assistant", content: "Added vitest specs." },
          ],
          dateCreated: "2026-01-11T10:00:00.000Z",
          updatedAt: "2026-01-11T12:00:00.000Z",
        }),
        "utf-8",
      );
      await writeFile(join(sessionsDir, "broken.json"), "{not-valid-json", "utf-8");
      await writeFile(join(sessionsDir, "readme.txt"), "ignore", "utf-8");

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(2);

      // Sorted newest first
      expect(sessions[0]?.id).toBe("continue-sess-2");
      expect(sessions[0]?.title).toBe("Add unit tests");
      expect(sessions[0]?.messageCount).toBe(2);

      expect(sessions[1]?.id).toBe("sess-1");
      expect(sessions[1]?.tool).toBe("continue");
      expect(sessions[1]?.toolName).toBe("Continue");
      expect(sessions[1]?.title).toBe("Fix auth middleware");
      expect(sessions[1]?.projectPath).toBe("/repo/app");
      expect(sessions[1]?.messages).toEqual([
        { role: "user", content: "Why is token refresh failing?" },
        { role: "assistant", content: "The expiry check is inverted.\nLet's fix src/auth.ts." },
      ]);
    });

    it("supports filtering sessions", async () => {
      const sessionsDir = join(home, ".continue/sessions");
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(
        join(sessionsDir, "a.json"),
        JSON.stringify({
          sessionId: "a",
          title: "Alpha",
          workspaceDirectory: "/repo/alpha",
          history: [{ message: { role: "user", content: "Hello Alpha" } }],
        }),
        "utf-8",
      );
      await writeFile(
        join(sessionsDir, "b.json"),
        JSON.stringify({
          sessionId: "b",
          title: "Beta",
          workspaceDirectory: "/repo/beta",
          history: [{ message: { role: "user", content: "Hello Beta" } }],
        }),
        "utf-8",
      );

      const filtered = await adapter.parseSessions({ projectPath: "/repo/alpha" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.id).toBe("a");
    });
  });
});
