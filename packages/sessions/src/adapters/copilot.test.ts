import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockHomeDir = "";

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHomeDir || actual.homedir(),
  };
});

import { CopilotSessionAdapter, resolveVsCodeWorkspaceStoragePath } from "./copilot.js";

describe("CopilotSessionAdapter", () => {
  let adapter: CopilotSessionAdapter;
  let tempHome: string;
  let originalAppData: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "ai-tools-copilot-sessions-"));
    mockHomeDir = tempHome;
    originalAppData = process.env.APPDATA;
    process.env.APPDATA = join(tempHome, "AppData", "Roaming");
    adapter = new CopilotSessionAdapter();
  });

  afterEach(async () => {
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    mockHomeDir = "";
    await rm(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("properties & detect", () => {
    it("has updated command and storagePaths", () => {
      expect(adapter.id).toBe("copilot");
      expect(adapter.name).toBe("GitHub Copilot");
      expect(adapter.command).toBe("copilot");
      expect(adapter.storagePaths).toContain("~/.copilot/session-state");
      expect(adapter.storagePaths).toContain("~/.config/github-copilot");
    });

    it("resolves OS-specific VS Code workspaceStorage paths", () => {
      expect(
        resolveVsCodeWorkspaceStoragePath("win32", { APPDATA: "C:\\AppData" }, "C:\\Users\\dev"),
      ).toBe(join("C:\\AppData", "Code", "User", "workspaceStorage"));
      expect(resolveVsCodeWorkspaceStoragePath("darwin", {}, "/Users/dev")).toBe(
        join("/Users/dev", "Library", "Application Support", "Code", "User", "workspaceStorage"),
      );
      expect(resolveVsCodeWorkspaceStoragePath("linux", {}, "/home/dev")).toBe(
        join("/home/dev", ".config", "Code", "User", "workspaceStorage"),
      );
    });

    it("detects copilot CLI and falls back to gh", async () => {
      const spy = vi
        .spyOn(
          adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
          "commandExists",
        )
        .mockImplementation(async (cmd) => cmd === "gh");

      expect(await adapter.detect()).toBe(true);
      expect(spy).toHaveBeenCalledWith("copilot");
      expect(spy).toHaveBeenCalledWith("gh");
    });
  });

  describe("parseSessions()", () => {
    it("returns empty array when no storage directories exist", async () => {
      expect(await adapter.parseSessions()).toEqual([]);
    });

    it("parses ~/.copilot/session-state/*/events.jsonl", async () => {
      const sessionDir = join(tempHome, ".copilot", "session-state", "sess-cli-1");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, "events.jsonl"),
        [
          JSON.stringify({
            type: "session.start",
            data: {
              sessionId: "cli-001",
              startTime: "2026-01-10T10:00:00.000Z",
              context: { cwd: "/repo/project" },
            },
          }),
          JSON.stringify({
            type: "user.message",
            data: { content: "Explain this error" },
            timestamp: "2026-01-10T10:00:05.000Z",
          }),
          JSON.stringify({
            type: "assistant.message",
            data: { content: "Here is the root cause." },
            timestamp: "2026-01-10T10:00:10.000Z",
          }),
        ].join("\n"),
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: "cli-001",
        tool: "copilot",
        projectPath: "/repo/project",
        messageCount: 2,
      });
      expect(sessions[0]?.messages[0]?.role).toBe("user");
      expect(sessions[0]?.messages[1]?.role).toBe("assistant");
    });

    it("parses VS Code workspaceStorage/*/chatSessions/*.json and *.jsonl", async () => {
      const wsDir = join(resolveVsCodeWorkspaceStoragePath(), "ws-hash-1", "chatSessions");
      await mkdir(wsDir, { recursive: true });

      await writeFile(
        join(wsDir, "chat-1.json"),
        JSON.stringify({
          sessionId: "vscode-json-1",
          customTitle: "Refactor auth",
          creationDate: 1736500000000,
          lastMessageDate: 1736500100000,
          requests: [
            {
              message: { text: "Refactor auth middleware" },
              response: [{ value: "Sure, let's split it up." }],
              timestamp: 1736500050000,
            },
          ],
        }),
      );

      await writeFile(
        join(wsDir, "chat-2.jsonl"),
        [
          JSON.stringify({
            kind: 0,
            v: {
              sessionId: "vscode-jsonl-2",
              customTitle: "Debug build",
              creationDate: 1736500200000,
              lastMessageDate: 1736500300000,
              requests: [
                {
                  message: { text: "Why does vite fail?" },
                  response: [{ value: "Missing dependency." }],
                },
              ],
            },
          }),
        ].join("\n"),
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions.find((s) => s.id === "vscode-json-1")).toMatchObject({
        title: "Refactor auth",
        messageCount: 2,
      });
      expect(sessions.find((s) => s.id === "vscode-jsonl-2")).toMatchObject({
        title: "Debug build",
        messageCount: 2,
      });
    });

    it("skips null and non-string VS Code response parts without dropping the session", async () => {
      const wsDir = join(resolveVsCodeWorkspaceStoragePath(), "ws-hash-rich", "chatSessions");
      await mkdir(wsDir, { recursive: true });

      await writeFile(
        join(wsDir, "rich.json"),
        JSON.stringify({
          sessionId: "vscode-rich-1",
          requests: [
            {
              message: { text: "Check rich parts" },
              response: [
                null,
                { kind: "treeData", value: { nested: true } },
                { value: "Valid text." },
              ],
            },
          ],
        }),
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.messages).toEqual([
        { role: "user", content: "Check rich parts", timestamp: undefined },
        { role: "assistant", content: "Valid text.", timestamp: undefined },
      ]);
    });

    it("parses legacy ~/.config/github-copilot/*.json alongside new locations", async () => {
      const legacyDir = join(tempHome, ".config", "github-copilot");
      await mkdir(legacyDir, { recursive: true });
      await writeFile(
        join(legacyDir, "legacy.json"),
        JSON.stringify({
          id: "cp-legacy-1",
          turns: [
            { role: "user", content: "Help me fix this" },
            { role: "copilot", content: "Sure, let me help" },
          ],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T01:00:00.000Z",
        }),
      );

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("cp-legacy-1");
      expect(sessions[0]?.messages).toHaveLength(2);
      expect(sessions[0]?.messages[1]?.role).toBe("assistant");
    });
  });
});
