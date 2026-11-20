import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { RooCodeSessionAdapter, resolveRooCodeTasksPath } from "./roo-code.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-sessions-roo-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveRooCodeTasksPath", () => {
  it("resolves Windows, macOS, and Linux globalStorage task paths", () => {
    expect(
      resolveRooCodeTasksPath(
        "win32",
        { APPDATA: "C:\\Users\\dev\\AppData\\Roaming" },
        "C:\\Users\\dev",
      ),
    ).toBe(
      join(
        "C:\\Users\\dev\\AppData\\Roaming",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "tasks",
      ),
    );

    expect(resolveRooCodeTasksPath("darwin", {}, "/Users/dev")).toBe(
      join(
        "/Users/dev",
        "Library",
        "Application Support",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "tasks",
      ),
    );

    expect(resolveRooCodeTasksPath("linux", {}, "/home/dev")).toBe(
      join(
        "/home/dev",
        ".config",
        "Code",
        "User",
        "globalStorage",
        "rooveterinaryinc.roo-cline",
        "tasks",
      ),
    );
  });
});

describe("RooCodeSessionAdapter", () => {
  describe("metadata", () => {
    it("has correct id, name, command, and default storagePaths", () => {
      const adapter = new RooCodeSessionAdapter();
      expect(adapter.id).toBe("roo-code");
      expect(adapter.name).toBe("Roo Code");
      expect(adapter.command).toBe("code");
      expect(adapter.storagePaths).toEqual([resolveRooCodeTasksPath()]);
    });
  });

  describe("detect", () => {
    it("returns true when tasks storage path exists and false otherwise", async () => {
      await withTempDir(async (dir) => {
        const missingAdapter = new RooCodeSessionAdapter([join(dir, "missing-tasks")]);
        expect(await missingAdapter.detect()).toBe(false);

        const tasksDir = join(dir, "tasks");
        await mkdir(tasksDir, { recursive: true });
        const presentAdapter = new RooCodeSessionAdapter([tasksDir]);
        expect(await presentAdapter.detect()).toBe(true);
      });
    });
  });

  describe("parseSessions", () => {
    it("returns empty array when storage path does not exist", async () => {
      await withTempDir(async (dir) => {
        const adapter = new RooCodeSessionAdapter([join(dir, "missing")]);
        expect(await adapter.parseSessions()).toEqual([]);
      });
    });

    it("parses api_conversation_history.json with history_item.json and task_metadata.json", async () => {
      await withTempDir(async (dir) => {
        const taskDir = join(dir, "1730000001000");
        await mkdir(taskDir, { recursive: true });

        await writeFile(
          join(taskDir, "api_conversation_history.json"),
          JSON.stringify([
            {
              role: "user",
              ts: 1730000001000,
              content: [
                { type: "text", text: "<task>\nFix auth token refresh in ./src/auth.ts\n</task>" },
              ],
            },
            {
              role: "assistant",
              ts: 1730000002000,
              content: [
                { type: "text", text: "I'll inspect ./src/auth.ts and fix the expiry check." },
                { type: "tool_use", name: "read_file", input: { path: "src/auth.ts" } },
              ],
            },
            {
              role: "user",
              ts: 1730000003000,
              content: [{ type: "tool_result", content: "export function refresh() {}" }],
            },
          ]),
          "utf-8",
        );

        await writeFile(
          join(taskDir, "history_item.json"),
          JSON.stringify({
            id: "1730000001000",
            ts: 1730000001000,
            task: "Fix auth token refresh",
            workspace: "/workspace/my-app",
            mode: "code",
            tokensIn: 1200,
            tokensOut: 450,
            totalCost: 0.025,
          }),
          "utf-8",
        );

        await writeFile(
          join(taskDir, "task_metadata.json"),
          JSON.stringify({
            files_in_context: [
              { path: "src/auth.ts", record_state: "active", record_source: "read_tool" },
            ],
          }),
          "utf-8",
        );

        const adapter = new RooCodeSessionAdapter([dir]);
        const sessions = await adapter.parseSessions();
        expect(sessions).toHaveLength(1);

        const session = sessions[0]!;
        expect(session.id).toBe("roo-code-1730000001000");
        expect(session.tool).toBe("roo-code");
        expect(session.toolName).toBe("Roo Code");
        expect(session.title).toBe("Fix auth token refresh");
        expect(session.projectPath).toBe("/workspace/my-app");
        expect(session.startedAt).toBe(new Date(1730000001000).toISOString());
        expect(session.updatedAt).toBe(new Date(1730000003000).toISOString());
        expect(session.messageCount).toBe(3);
        expect(session.messages[0]).toMatchObject({ role: "user" });
        expect(session.messages[1]).toMatchObject({ role: "assistant", toolName: "read_file" });
        expect(session.messages[2]).toMatchObject({
          role: "tool",
          content: "export function refresh() {}",
        });
        expect(session.metadata).toEqual({
          mode: "code",
          tokensIn: 1200,
          tokensOut: 450,
          totalCost: 0.025,
          filesInContext: ["src/auth.ts"],
        });

        const ctx = await adapter.extractContext(session);
        expect(ctx.title).toBe("Fix auth token refresh");
        expect(ctx.keyFiles).toContain("./src/auth.ts");
        expect(ctx.handoffMarkdown).toContain("# Session Handoff: Fix auth token refresh");
      });
    });

    it("falls back to <task> content for title when history_item.json is absent, sorts newest-first, and filters", async () => {
      await withTempDir(async (dir) => {
        const olderDir = join(dir, "task-old");
        const newerDir = join(dir, "task-new");
        const brokenDir = join(dir, "task-broken");
        await mkdir(olderDir, { recursive: true });
        await mkdir(newerDir, { recursive: true });
        await mkdir(brokenDir, { recursive: true });

        await writeFile(join(dir, "not-a-dir.txt"), "skip", "utf-8");
        await writeFile(join(brokenDir, "api_conversation_history.json"), "{bad json", "utf-8");

        await writeFile(
          join(olderDir, "api_conversation_history.json"),
          JSON.stringify([
            { role: "user", ts: 1730000001000, content: "<task>\nOlder task title\n</task>" },
            { role: "assistant", ts: 1730000002000, content: "Done." },
          ]),
          "utf-8",
        );

        await writeFile(
          join(newerDir, "api_conversation_history.json"),
          JSON.stringify([
            { role: "user", ts: 1730000010000, content: "Newer task title" },
            { role: "assistant", ts: 1730000020000, content: "Completed." },
          ]),
          "utf-8",
        );
        await writeFile(
          join(newerDir, "history_item.json"),
          JSON.stringify({ workspace: "/repo/beta", ts: 1730000010000 }),
          "utf-8",
        );

        const adapter = new RooCodeSessionAdapter([dir]);
        const all = await adapter.parseSessions();
        expect(all.map((s) => s.id)).toEqual(["roo-code-task-new", "roo-code-task-old"]);
        expect(all[1]!.title).toBe("Older task title");

        const filtered = await adapter.parseSessions({ projectPath: "/repo/beta", limit: 1 });
        expect(filtered).toHaveLength(1);
        expect(filtered[0]!.id).toBe("roo-code-task-new");
      });
    });

    it("handles win32 empty APPDATA, linux XDG_CONFIG_HOME, tool_use-only messages, array tool_result, cwd & stat fallbacks, and malformed task_metadata", async () => {
      expect(resolveRooCodeTasksPath("win32", { APPDATA: "" }, "C:\\Users\\dev")).toBe(
        join(
          "C:\\Users\\dev",
          "AppData",
          "Roaming",
          "Code",
          "User",
          "globalStorage",
          "rooveterinaryinc.roo-cline",
          "tasks",
        ),
      );
      expect(resolveRooCodeTasksPath("linux", { XDG_CONFIG_HOME: "/xdg/cfg" }, "/home/dev")).toBe(
        join("/xdg/cfg", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "tasks"),
      );

      await withTempDir(async (dir) => {
        const taskDir = join(dir, "task-edge");
        await mkdir(taskDir, { recursive: true });

        await writeFile(
          join(taskDir, "api_conversation_history.json"),
          JSON.stringify([
            { role: "user", content: "Run check" },
            {
              role: "assistant",
              content: [{ type: "tool_use", name: "execute_command", input: { command: "ls" } }],
            },
            {
              role: "user",
              content: [{ type: "tool_result", content: [{ type: "text", text: "README.md" }] }],
            },
          ]),
          "utf-8",
        );

        await writeFile(
          join(taskDir, "history_item.json"),
          JSON.stringify({ cwd: "/repo/cwd-fallback", ts: "not-a-number" }),
          "utf-8",
        );

        await writeFile(
          join(taskDir, "task_metadata.json"),
          JSON.stringify({ files_in_context: "malformed" }),
          "utf-8",
        );

        const adapter = new RooCodeSessionAdapter([dir]);
        const sessions = await adapter.parseSessions();
        expect(sessions).toHaveLength(1);
        const session = sessions[0]!;
        expect(session.projectPath).toBe("/repo/cwd-fallback");
        expect(Number.isNaN(Date.parse(session.startedAt))).toBe(false);
        expect(Number.isNaN(Date.parse(session.updatedAt))).toBe(false);
        expect(session.messages[1]).toEqual({
          role: "assistant",
          content: "[tool_use: execute_command]",
          toolName: "execute_command",
        });
        expect(session.messages[2]).toEqual({
          role: "tool",
          content: "README.md",
        });
      });
    });
  });
});
