import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClineSessionAdapter, getClineSessionStoragePaths } from "./cline.js";
import { registry } from "./registry.js";
import "./all.js";

describe("ClineSessionAdapter", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-tools-cline-sessions-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("registration & storage paths", () => {
    it("is registered in the session adapter registry via all.ts", () => {
      const registered = registry.get("cline");
      expect(registered).toBeDefined();
      expect(registered?.name).toBe("Cline");
    });

    it("returns OS-specific VS Code globalStorage and CLI ~/.cline/data paths", () => {
      const macPaths = getClineSessionStoragePaths({
        platform: "darwin",
        home: "/Users/dev",
        env: {},
      });
      expect(macPaths[0]).toContain("Library");
      expect(macPaths[0]).toContain("saoudrizwan.claude-dev");
      expect(macPaths[1]).toBe(join("/Users/dev", ".cline", "data"));

      const winPaths = getClineSessionStoragePaths({
        platform: "win32",
        home: "C:\\Users\\dev",
        env: { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
      });
      expect(winPaths[0]).toContain("saoudrizwan.claude-dev");
      expect(winPaths[1]).toBe(join("C:\\Users\\dev", ".cline", "data"));

      const linuxPaths = getClineSessionStoragePaths({
        platform: "linux",
        home: "/home/dev",
        env: { XDG_CONFIG_HOME: "/home/dev/.xdg" },
      });
      expect(linuxPaths[0]).toContain(".xdg");
      expect(linuxPaths[1]).toBe(join("/home/dev", ".cline", "data"));
    });
  });

  describe("parseSessions", () => {
    it("reads VS Code globalStorage taskHistory, api_conversation_history, and ui_messages", async () => {
      const vscodeRoot = join(tempDir, "vscode-cline");
      const task1Dir = join(vscodeRoot, "tasks", "1730000001000");
      const task2Dir = join(vscodeRoot, "tasks", "1730000002000");

      await mkdir(join(vscodeRoot, "state"), { recursive: true });
      await mkdir(task1Dir, { recursive: true });
      await mkdir(task2Dir, { recursive: true });

      await writeFile(
        join(vscodeRoot, "state", "taskHistory.json"),
        JSON.stringify([
          {
            id: "1730000001000",
            ts: 1730000001000,
            task: "Fix authentication middleware",
            tokensIn: 1200,
            tokensOut: 450,
            totalCost: 0.04,
            cwdOnTaskInitialization: "/workspace/api",
          },
          {
            id: "1730000002000",
            ts: 1730000002000,
            task: "Add unit tests for parser",
            cwdOnTaskInitialization: "/workspace/parser",
          },
        ]),
        "utf-8",
      );

      await writeFile(
        join(task1Dir, "api_conversation_history.json"),
        JSON.stringify([
          { role: "user", content: [{ type: "text", text: "Fix authentication middleware" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "I'll inspect src/auth.ts first." },
              { type: "tool_use", name: "read_file", input: { path: "src/auth.ts" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", content: "export function verify() {}" }],
          },
          { role: "assistant", content: "Updated JWT verification." },
        ]),
        "utf-8",
      );

      await writeFile(
        join(task1Dir, "ui_messages.json"),
        JSON.stringify([
          { ts: 1730000001000, type: "say", say: "task", text: "Fix authentication middleware" },
          { ts: 1730000099000, type: "say", say: "completion_result", text: "Done" },
        ]),
        "utf-8",
      );

      // Task 2 has only ui_messages.json (fallback path)
      await writeFile(
        join(task2Dir, "ui_messages.json"),
        JSON.stringify([
          { ts: 1730000002000, type: "say", say: "task", text: "Add unit tests for parser" },
          { ts: 1730000005000, type: "say", say: "text", text: "Added vitest specs." },
        ]),
        "utf-8",
      );

      const adapter = new ClineSessionAdapter([vscodeRoot]);
      expect(await adapter.detect()).toBe(true);

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(2);

      // Sorted newest first by updatedAt (task1 had ui_messages ts 1730000099000)
      expect(sessions[0]!.id).toBe("cline-1730000001000");
      expect(sessions[0]!.title).toBe("Fix authentication middleware");
      expect(sessions[0]!.projectPath).toBe("/workspace/api");
      expect(sessions[0]!.startedAt).toBe(new Date(1730000001000).toISOString());
      expect(sessions[0]!.updatedAt).toBe(new Date(1730000099000).toISOString());
      expect(sessions[0]!.metadata).toEqual({
        tokensIn: 1200,
        tokensOut: 450,
        totalCost: 0.04,
      });
      expect(
        sessions[0]!.messages.some((m) => m.role === "tool" && m.toolName === "read_file"),
      ).toBe(true);

      expect(sessions[1]!.id).toBe("cline-1730000002000");
      expect(sessions[1]!.messages).toHaveLength(2);
      expect(sessions[1]!.messages[0]!.role).toBe("user");
      expect(sessions[1]!.messages[1]!.role).toBe("assistant");
    });

    it("combines VS Code and CLI ~/.cline/data/tasks/ roots and supports filters", async () => {
      const vscodeRoot = join(tempDir, "vscode");
      const cliRoot = join(tempDir, "cli-data");

      await mkdir(join(vscodeRoot, "tasks", "task-vscode"), { recursive: true });
      await writeFile(
        join(vscodeRoot, "tasks", "task-vscode", "api_conversation_history.json"),
        JSON.stringify([{ role: "user", content: "VS Code task" }]),
        "utf-8",
      );

      await mkdir(join(cliRoot, "tasks", "task-cli"), { recursive: true });
      await writeFile(
        join(cliRoot, "tasks", "task-cli", "api_conversation_history.json"),
        JSON.stringify([{ role: "user", content: "CLI task" }]),
        "utf-8",
      );

      // Malformed task should be skipped gracefully
      await mkdir(join(cliRoot, "tasks", "task-broken"), { recursive: true });
      await writeFile(
        join(cliRoot, "tasks", "task-broken", "api_conversation_history.json"),
        "{not valid json",
        "utf-8",
      );

      const adapter = new ClineSessionAdapter([vscodeRoot, cliRoot]);
      const all = await adapter.parseSessions();
      expect(all.map((s) => s.id).toSorted()).toEqual(["cline-task-cli", "cline-task-vscode"]);

      const limited = await adapter.parseSessions({ limit: 1 });
      expect(limited).toHaveLength(1);
    });

    it("returns empty array when no storage roots exist", async () => {
      const adapter = new ClineSessionAdapter([join(tempDir, "missing")]);
      expect(await adapter.parseSessions()).toEqual([]);
    });
  });
});
