import { describe, it, expect } from "vitest";
import type { AiHooksConfig, HookEvent } from "../types/index.js";
import { buildGeminiEvent, parseGeminiPayload, runGeminiHook } from "./gemini-runner.js";

function makeBuffer() {
  let text = "";
  return {
    stream: {
      write(chunk: string) {
        text += chunk;
        return true;
      },
    },
    text: () => text,
  };
}

describe("gemini-runner", () => {
  describe("parseGeminiPayload", () => {
    it("parses valid JSON object", () => {
      expect(
        parseGeminiPayload('{"hook_event_name":"BeforeTool","tool_name":"read_file"}'),
      ).toEqual({
        hook_event_name: "BeforeTool",
        tool_name: "read_file",
      });
    });

    it("returns empty object on invalid or non-object JSON", () => {
      expect(parseGeminiPayload("not-json")).toEqual({});
      expect(parseGeminiPayload("[]")).toEqual({});
      expect(parseGeminiPayload("")).toEqual({});
    });
  });

  describe("buildGeminiEvent", () => {
    it("maps SessionStart and SessionEnd", () => {
      const start = buildGeminiEvent("SessionStart", { cwd: "/repo" });
      expect(start?.type).toBe("session:start");
      if (start?.type === "session:start") {
        expect(start.tool).toBe("gemini-cli");
        expect(start.workingDirectory).toBe("/repo");
      }

      const end = buildGeminiEvent("SessionEnd", {});
      expect(end?.type).toBe("session:end");
    });

    it("maps BeforeAgent and AfterAgent", () => {
      const before = buildGeminiEvent("BeforeAgent", { prompt: "Fix the bug" });
      expect(before?.type).toBe("prompt:submit");
      if (before?.type === "prompt:submit") {
        expect(before.prompt).toBe("Fix the bug");
      }

      const after = buildGeminiEvent("AfterAgent", {
        prompt_response: "Done fixing",
        model: "gemini-2.5-pro",
      });
      expect(after?.type).toBe("prompt:response");
      if (after?.type === "prompt:response") {
        expect(after.response).toBe("Done fixing");
        expect(after.model).toBe("gemini-2.5-pro");
      }
    });

    it("maps Notification", () => {
      const notif = buildGeminiEvent("Notification", {
        notification_type: "ToolPermission",
        message: "Approval required",
      });
      expect(notif?.type).toBe("notification");
      if (notif?.type === "notification") {
        expect(notif.message).toBe("Approval required");
      }
    });

    it("maps Gemini built-in BeforeTool tools", () => {
      const shell = buildGeminiEvent("BeforeTool", {
        tool_name: "run_shell_command",
        tool_input: { command: "rm -rf /tmp/x", directory: "/repo" },
      });
      expect(shell?.type).toBe("shell:before");
      if (shell?.type === "shell:before") {
        expect(shell.command).toBe("rm -rf /tmp/x");
        expect(shell.cwd).toBe("/repo");
      }

      const write = buildGeminiEvent("BeforeTool", {
        tool_name: "write_file",
        tool_input: { file_path: "src/app.ts", content: "export const x = 1;" },
      });
      expect(write?.type).toBe("file:write");
      if (write?.type === "file:write") {
        expect(write.path).toBe("src/app.ts");
        expect(write.content).toBe("export const x = 1;");
      }

      const edit = buildGeminiEvent("BeforeTool", {
        tool_name: "replace",
        tool_input: { file_path: "src/app.ts", old_string: "1", new_string: "2" },
      });
      expect(edit?.type).toBe("file:edit");
      if (edit?.type === "file:edit") {
        expect(edit.path).toBe("src/app.ts");
        expect(edit.oldContent).toBe("1");
        expect(edit.newContent).toBe("2");
      }

      const read = buildGeminiEvent("BeforeTool", {
        tool_name: "read_file",
        tool_input: { absolute_path: "/repo/README.md" },
      });
      expect(read?.type).toBe("file:read");
      if (read?.type === "file:read") {
        expect(read.path).toBe("/repo/README.md");
      }

      const mcp = buildGeminiEvent("BeforeTool", {
        tool_name: "mcp_github_create_issue",
        tool_input: { title: "Bug" },
      });
      expect(mcp?.type).toBe("mcp:before");
      if (mcp?.type === "mcp:before") {
        expect(mcp.server).toBe("github");
        expect(mcp.method).toBe("create_issue");
        expect(mcp.params).toEqual({ title: "Bug" });
      }
    });

    it("maps AfterTool for shell, mcp, and generic tools", () => {
      const shell = buildGeminiEvent("AfterTool", {
        tool_name: "run_shell_command",
        tool_input: { command: "echo hi" },
        tool_response: { exitCode: 0, stdout: "hi\n", stderr: "" },
      });
      expect(shell?.type).toBe("shell:after");
      if (shell?.type === "shell:after") {
        expect(shell.command).toBe("echo hi");
        expect(shell.stdout).toBe("hi\n");
      }

      const mcp = buildGeminiEvent("AfterTool", {
        tool_name: "mcp_linear_list_issues",
        tool_input: { team: "ENG" },
        tool_response: { issues: [] },
      });
      expect(mcp?.type).toBe("mcp:after");
      if (mcp?.type === "mcp:after") {
        expect(mcp.server).toBe("linear");
        expect(mcp.method).toBe("list_issues");
      }

      const generic = buildGeminiEvent("AfterTool", {
        tool_name: "web_search",
        tool_input: { query: "gemini cli" },
        tool_response: { results: 3 },
      });
      expect(generic?.type).toBe("tool:after");
      if (generic?.type === "tool:after") {
        expect(generic.toolName).toBe("web_search");
        expect(generic.output).toEqual({ results: 3 });
      }
    });
  });

  describe("runGeminiHook", () => {
    it("blocks BeforeTool with stdout JSON decision deny and exit 0", async () => {
      const stdout = makeBuffer();
      const stderr = makeBuffer();
      const config: AiHooksConfig = {
        hooks: [
          {
            id: "deny-rm",
            name: "Deny rm",
            events: ["shell:before"],
            phase: "before",
            handler: async (ctx) => {
              ctx.results.push({ blocked: true, reason: "Dangerous shell command" });
            },
          },
        ],
      };

      const exitCode = await runGeminiHook({
        stdin: JSON.stringify({
          hook_event_name: "BeforeTool",
          tool_name: "run_shell_command",
          tool_input: { command: "rm -rf /" },
        }),
        config,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(exitCode).toBe(0);
      expect(stderr.text()).toBe("");
      expect(JSON.parse(stdout.text())).toEqual({
        decision: "deny",
        reason: "Dangerous shell command",
      });
    });

    it("blocks BeforeAgent with stdout JSON decision deny and exit 0", async () => {
      const stdout = makeBuffer();
      const config: AiHooksConfig = {
        hooks: [
          {
            id: "deny-secret-prompt",
            name: "Deny Secret Prompt",
            events: ["prompt:submit"],
            phase: "before",
            handler: async (ctx) => {
              ctx.results.push({ blocked: true, reason: "Prompt contains secret" });
            },
          },
        ],
      };

      const exitCode = await runGeminiHook({
        stdin: JSON.stringify({
          hook_event_name: "BeforeAgent",
          prompt: "Here is AKIA...",
        }),
        config,
        stdout: stdout.stream,
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.text())).toEqual({
        decision: "deny",
        reason: "Prompt contains secret",
      });
    });

    it("passes through allowed events with empty stdout and exit 0", async () => {
      const seen: HookEvent[] = [];
      const stdout = makeBuffer();
      const config: AiHooksConfig = {
        hooks: [
          {
            id: "observe-file",
            name: "Observe File",
            events: ["file:write"],
            phase: "before",
            handler: async (ctx, next) => {
              seen.push(ctx.event);
              await next();
            },
          },
        ],
      };

      const chunks = [
        Buffer.from('{"hook_event_name":"BeforeTool",'),
        Buffer.from('"tool_name":"write_file","tool_input":{"file_path":"a.ts","content":"x"}}'),
      ];
      async function* stream() {
        for (const chunk of chunks) yield chunk;
      }

      const exitCode = await runGeminiHook({
        stdin: stream(),
        config,
        stdout: stdout.stream,
      });

      expect(exitCode).toBe(0);
      expect(stdout.text()).toBe("");
      expect(seen).toHaveLength(1);
      expect(seen[0]?.type).toBe("file:write");
    });

    it("returns 0 cleanly for unknown events or invalid stdin", async () => {
      const stdout = makeBuffer();
      const exitCode = await runGeminiHook({
        stdin: "not json",
        config: { hooks: [] },
        stdout: stdout.stream,
      });
      expect(exitCode).toBe(0);
      expect(stdout.text()).toBe("");
    });
  });
});
