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

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (error: Error | null) => void) => {
    cb(new Error("not found"));
  }),
}));

import { execFile } from "node:child_process";
import { AntigravityCliSessionAdapter } from "./antigravity-cli.js";

describe("AntigravityCliSessionAdapter", () => {
  let adapter: AntigravityCliSessionAdapter;
  let home: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    home = await mkdtemp(join(tmpdir(), "agy-sessions-home-"));
    mockHome.value = home;
    adapter = new AntigravityCliSessionAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(home, { recursive: true, force: true });
  });

  it("uses Antigravity CLI identity, agy command, and brain storage paths", () => {
    expect(adapter.id).toBe("antigravity-cli");
    expect(adapter.name).toBe("Antigravity CLI");
    expect(adapter.command).toBe("agy");
    expect(adapter.storagePaths).toEqual([
      "~/.gemini/antigravity-cli/brain",
      "~/.gemini/antigravity/brain",
    ]);
  });

  it("detects storage path, settings.json, and agy command", async () => {
    expect(await adapter.detect()).toBe(false);

    await mkdir(join(home, ".gemini/antigravity-cli"), { recursive: true });
    await writeFile(join(home, ".gemini/antigravity-cli/settings.json"), "{}\n", "utf-8");
    expect(await adapter.detect()).toBe(true);

    await rm(join(home, ".gemini"), { recursive: true, force: true });
    await mkdir(join(home, ".gemini/antigravity/brain"), { recursive: true });
    expect(await adapter.detect()).toBe(true);

    await rm(join(home, ".gemini"), { recursive: true, force: true });
    vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof execFile);
    expect(await adapter.detect()).toBe(true);
  });

  it("parses USER_INPUT and PLANNER_RESPONSE steps from transcript.jsonl across both brain paths", async () => {
    const conv1Logs = join(home, ".gemini/antigravity-cli/brain/conv-1/.system_generated/logs");
    const conv2Logs = join(home, ".gemini/antigravity/brain/conv-2/.system_generated/logs");
    await mkdir(conv1Logs, { recursive: true });
    await mkdir(conv2Logs, { recursive: true });

    await writeFile(
      join(conv1Logs, "transcript.jsonl"),
      [
        JSON.stringify({
          step_index: 0,
          type: "USER_INPUT",
          content: "Fix the auth bug",
          created_at: "2026-11-20T10:00:00.000Z",
        }),
        JSON.stringify({
          step_index: 1,
          type: "TOOL_CALL",
          content: "ignored tool step",
          created_at: "2026-11-20T10:01:00.000Z",
        }),
        JSON.stringify({
          step_index: 2,
          type: "PLANNER_RESPONSE",
          content: "I'll inspect src/auth.ts and fix the token check.",
          created_at: "2026-11-20T10:02:00.000Z",
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    await writeFile(
      join(conv2Logs, "transcript.jsonl"),
      [
        JSON.stringify({
          step_index: 0,
          type: "USER_INPUT",
          content: "Add MCP adapter",
          created_at: "2026-11-20T12:00:00.000Z",
        }),
        JSON.stringify({
          step_index: 1,
          type: "PLANNER_RESPONSE",
          content: "Created packages/mcp/src/adapters/antigravity-cli.ts.",
          created_at: "2026-11-20T12:05:00.000Z",
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const sessions = await adapter.parseSessions();
    expect(sessions).toHaveLength(2);
    // Newest first
    expect(sessions[0]?.id).toBe("conv-2");
    expect(sessions[0]?.title).toBe("Add MCP adapter");
    expect(sessions[0]?.messageCount).toBe(2);
    expect(sessions[0]?.startedAt).toBe("2026-11-20T12:00:00.000Z");
    expect(sessions[0]?.updatedAt).toBe("2026-11-20T12:05:00.000Z");

    expect(sessions[1]?.id).toBe("conv-1");
    expect(sessions[1]?.title).toBe("Fix the auth bug");
    expect(sessions[1]?.messages).toEqual([
      {
        role: "user",
        content: "Fix the auth bug",
        timestamp: "2026-11-20T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "I'll inspect src/auth.ts and fix the token check.",
        timestamp: "2026-11-20T10:02:00.000Z",
      },
    ]);

    const limited = await adapter.parseSessions({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.id).toBe("conv-2");
  });
});
