import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KiroSessionAdapter } from "./kiro.js";
import { registry } from "./registry.js";

describe("KiroSessionAdapter", () => {
  let adapter: KiroSessionAdapter;
  let tempDir: string;
  let originalKiroHome: string | undefined;

  beforeEach(async () => {
    adapter = new KiroSessionAdapter();
    tempDir = await mkdtemp(join(tmpdir(), "kiro-sessions-test-"));
    originalKiroHome = process.env.KIRO_HOME;
    process.env.KIRO_HOME = tempDir;
  });

  afterEach(async () => {
    if (originalKiroHome === undefined) {
      delete process.env.KIRO_HOME;
    } else {
      process.env.KIRO_HOME = originalKiroHome;
    }
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("metadata & registration", () => {
    it("has correct metadata and registers in session registry", async () => {
      expect(adapter.id).toBe("kiro");
      expect(adapter.name).toBe("Kiro CLI");
      expect(adapter.command).toBe("kiro-cli");
      expect(adapter.storagePaths).toEqual(["~/.kiro/sessions/cli"]);

      await import("./all.js");
      expect(registry.get("kiro")).toBeDefined();
    });
  });

  describe("getStoragePath & detect", () => {
    it("resolves $KIRO_HOME/sessions/cli when present", async () => {
      const cliDir = join(tempDir, "sessions", "cli");
      await mkdir(cliDir, { recursive: true });
      expect(await adapter.getStoragePath()).toBe(cliDir);
      expect(await adapter.detect()).toBe(true);
    });

    it("detects kiro-cli or kiro binary even when storage path does not exist", async () => {
      const spy = vi
        .spyOn(
          adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
          "commandExists",
        )
        .mockImplementation(async (cmd) => cmd === "kiro");

      expect(await adapter.detect()).toBe(true);
      expect(spy).toHaveBeenCalledWith("kiro-cli");
      expect(spy).toHaveBeenCalledWith("kiro");
    });
  });

  describe("parseSessions", () => {
    it("parses Kiro CLI V3 .json + .jsonl pairs from $KIRO_HOME/sessions/cli", async () => {
      const cliDir = join(tempDir, "sessions", "cli");
      await mkdir(cliDir, { recursive: true });

      // Paired .json + .jsonl session
      await writeFile(
        join(cliDir, "sess-001.json"),
        JSON.stringify({
          session_id: "sess-001",
          title: "Refactor Kiro adapters",
          cwd: "/workspace/ai-tools",
          created_at: "2026-05-01T10:00:00.000Z",
          updated_at: "2026-05-01T10:30:00.000Z",
          model: "claude-sonnet-4",
          agent: "default",
        }),
        "utf-8",
      );
      await writeFile(
        join(cliDir, "sess-001.jsonl"),
        [
          JSON.stringify({
            role: "user",
            content: "Update the Kiro MCP adapter.",
            timestamp: "2026-05-01T10:01:00.000Z",
          }),
          JSON.stringify({
            role: "assistant",
            content: [{ type: "text", text: "I'll update packages/mcp/src/adapters/kiro.ts." }],
            timestamp: "2026-05-01T10:02:00.000Z",
          }),
          JSON.stringify({
            role: "tool",
            tool_name: "fs_write",
            content: "Wrote kiro.ts",
            timestamp: "2026-05-01T10:03:00.000Z",
          }),
          "not valid json line",
        ].join("\n") + "\n",
        "utf-8",
      );

      // Older .jsonl-only session
      await writeFile(
        join(cliDir, "sess-002.jsonl"),
        [
          JSON.stringify({
            type: "human",
            message: { content: "Investigate hook runner bug" },
            timestamp: "2026-04-01T08:00:00.000Z",
          }),
          JSON.stringify({
            type: "assistant",
            message: { content: "Checking Windows path escaping." },
            timestamp: "2026-04-01T08:05:00.000Z",
          }),
        ].join("\n") + "\n",
        "utf-8",
      );
      await writeFile(
        join(cliDir, "sess-002.json"),
        JSON.stringify({
          created_at: "2026-04-01T08:00:00.000Z",
          updated_at: "2026-04-01T08:05:00.000Z",
        }),
        "utf-8",
      );

      // Empty session should be skipped
      await writeFile(join(cliDir, "empty.jsonl"), "\n", "utf-8");

      const sessions = await adapter.parseSessions();
      expect(sessions).toHaveLength(2);

      // Sorted newest first
      expect(sessions[0]!.id).toBe("sess-001");
      expect(sessions[0]!.tool).toBe("kiro");
      expect(sessions[0]!.toolName).toBe("Kiro CLI");
      expect(sessions[0]!.title).toBe("Refactor Kiro adapters");
      expect(sessions[0]!.projectPath).toBe("/workspace/ai-tools");
      expect(sessions[0]!.startedAt).toBe("2026-05-01T10:00:00.000Z");
      expect(sessions[0]!.updatedAt).toBe("2026-05-01T10:30:00.000Z");
      expect(sessions[0]!.messageCount).toBe(3);
      expect(sessions[0]!.messages[2]!.toolName).toBe("fs_write");
      expect(sessions[0]!.metadata).toEqual({ model: "claude-sonnet-4", agent: "default" });

      expect(sessions[1]!.id).toBe("kiro-sess-002");
      expect(sessions[1]!.title).toBe("Investigate hook runner bug");
      expect(sessions[1]!.messageCount).toBe(2);

      // Filter support
      const filtered = await adapter.parseSessions({
        projectPath: "/workspace/ai-tools",
        limit: 1,
      });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.id).toBe("sess-001");
    });

    it("returns empty array when storage directory does not exist", async () => {
      vi.spyOn(adapter, "getStoragePath").mockResolvedValue(null);
      expect(await adapter.parseSessions()).toEqual([]);
    });
  });
});
