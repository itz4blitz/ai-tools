import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockHome } = vi.hoisted(() => ({ mockHome: { value: "" } }));

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHome.value || actual.homedir(),
  };
});

import { DroidSessionAdapter } from "./droid.js";

describe("DroidSessionAdapter", () => {
  let adapter: DroidSessionAdapter;
  let home: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    home = await mkdtemp(join(tmpdir(), "ai-tools-droid-sessions-"));
    mockHome.value = home;
    adapter = new DroidSessionAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(home, { recursive: true, force: true });
  });

  describe("properties", () => {
    it("has correct id, name, command, and storagePaths", () => {
      expect(adapter.id).toBe("droid");
      expect(adapter.name).toBe("Factory Droid");
      expect(adapter.command).toBe("droid");
      expect(adapter.storagePaths).toEqual(["~/.factory/sessions", "~/.factory/projects"]);
    });
  });

  describe("parseSessions()", () => {
    it("returns empty array when neither storage path exists", async () => {
      expect(await adapter.parseSessions()).toEqual([]);
    });

    it("parses real Factory Droid nested <encoded-cwd>/<uuid>.jsonl fixtures", async () => {
      const projectDir = join(home, ".factory", "sessions", "-Users-dev-myapp");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, "550e8400-e29b-41d4-a716-446655440000.jsonl"),
        [
          JSON.stringify({
            type: "session_start",
            id: "550e8400-e29b-41d4-a716-446655440000",
            title: "Fix authentication flow",
            cwd: "/Users/dev/myapp",
          }),
          JSON.stringify({
            type: "message",
            timestamp: "2026-01-10T10:00:00Z",
            message: {
              role: "user",
              content: "Please fix the OAuth callback bug.",
            },
          }),
          JSON.stringify({
            type: "message",
            timestamp: "2026-01-10T10:00:05Z",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", text: "ignored thinking block" },
                { type: "text", text: "I'll inspect the OAuth handler." },
                { type: "text", text: "Found the missing state check." },
              ],
            },
          }),
        ].join("\n") + "\n",
        "utf-8",
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      const session = sessions[0]!;
      expect(session.id).toBe("droid-550e8400-e29b-41d4-a716-446655440000");
      expect(session.title).toBe("Fix authentication flow");
      expect(session.projectPath).toBe("/Users/dev/myapp");
      expect(session.messageCount).toBe(2);
      expect(session.messages[0]).toEqual({
        role: "user",
        content: "Please fix the OAuth callback bug.",
        timestamp: "2026-01-10T10:00:00Z",
      });
      expect(session.messages[1]).toEqual({
        role: "assistant",
        content: "I'll inspect the OAuth handler.\nFound the missing state check.",
        timestamp: "2026-01-10T10:00:05Z",
      });
    });

    it("scans root <uuid>.jsonl files and supports flat entry fallback", async () => {
      const sessionsDir = join(home, ".factory", "sessions");
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(
        join(sessionsDir, "root-session.jsonl"),
        [
          JSON.stringify({ type: "human", text: "Hello via flat text" }),
          JSON.stringify({ role: "assistant", content: "Hi there" }),
          JSON.stringify({ role: "unknown", content: "skip me" }),
        ].join("\n") + "\n",
        "utf-8",
      );
      await writeFile(join(sessionsDir, "config.json"), '{"ignore":true}', "utf-8");

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.id).toBe("droid-root-session");
      expect(sessions[0]!.title).toBe("Hello via flat text");
      expect(sessions[0]!.messages).toHaveLength(2);
      expect(sessions[0]!.messages[0]!.role).toBe("user");
      expect(sessions[0]!.messages[0]!.content).toBe("Hello via flat text");
    });

    it("scans ~/.factory/projects in addition to ~/.factory/sessions", async () => {
      const projectsDir = join(home, ".factory", "projects", "encoded-repo");
      await mkdir(projectsDir, { recursive: true });
      await writeFile(
        join(projectsDir, "proj-1.jsonl"),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "Refactor parser" },
        }) + "\n",
        "utf-8",
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.id).toBe("droid-proj-1");
      expect(sessions[0]!.projectPath).toBe("encoded-repo");
    });

    it("skips malformed jsonl lines and files with no valid messages", async () => {
      const sessionsDir = join(home, ".factory", "sessions");
      await mkdir(sessionsDir, { recursive: true });
      await writeFile(join(sessionsDir, "broken.jsonl"), "{not-valid-json\n", "utf-8");
      await writeFile(
        join(sessionsDir, "partial.jsonl"),
        '{bad\n{"role":"user","content":"Valid line"}\n',
        "utf-8",
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.id).toBe("droid-partial");
      expect(sessions[0]!.messages[0]!.content).toBe("Valid line");
    });
  });
});
