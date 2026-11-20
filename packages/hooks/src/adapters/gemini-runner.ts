import { loadConfig } from "../config/index.js";
import { HookEngine } from "../runtime/index.js";
import type { HookEvent } from "../types/index.js";
import { asRecord, stringField } from "./claude-compat.js";
import { readStdinText, type HookRunnerIO } from "./grok-runner.js";

export type GeminiHookPayload = {
  hook_event_name?: string;
  hookEventName?: string;
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string | number;
  prompt?: string;
  prompt_response?: string;
  promptResponse?: string;
  response?: string;
  model?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  tool_response?: unknown;
  toolResult?: unknown;
  notification_type?: string;
  notificationType?: string;
  message?: string;
  [key: string]: unknown;
};

const BLOCKING_GEMINI_EVENTS = new Set(["BeforeTool", "BeforeAgent"]);

export function parseGeminiPayload(raw: string): GeminiHookPayload {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as GeminiHookPayload;
    }
    return {};
  } catch {
    return {};
  }
}

export function buildGeminiEvent(
  nativeEvent: string,
  payload: GeminiHookPayload,
): HookEvent | null {
  const timestamp = resolveTimestamp(payload.timestamp);
  const metadata: Record<string, unknown> = { nativeEvent, payload };
  const cwd = stringField(payload.cwd) || process.cwd();
  const toolName = stringField(payload.tool_name) || stringField(payload.toolName);
  const toolInput =
    payload.tool_input !== undefined
      ? asRecord(payload.tool_input)
      : payload.toolInput !== undefined
        ? asRecord(payload.toolInput)
        : {};
  const toolResponse = payload.tool_response ?? payload.toolResult ?? {};

  switch (nativeEvent) {
    case "SessionStart":
      return {
        type: "session:start",
        tool: "gemini-cli",
        version: "1.0",
        workingDirectory: cwd,
        timestamp,
        metadata,
      };
    case "SessionEnd":
      return {
        type: "session:end",
        tool: "gemini-cli",
        duration: 0,
        timestamp,
        metadata,
      };
    case "BeforeAgent":
      return {
        type: "prompt:submit",
        prompt: stringField(payload.prompt) || stringField(toolInput.prompt),
        timestamp,
        metadata,
      };
    case "AfterAgent":
      return {
        type: "prompt:response",
        response:
          stringField(payload.prompt_response) ||
          stringField(payload.promptResponse) ||
          stringField(payload.response),
        model: stringField(payload.model) || "gemini-cli",
        tokens: { input: 0, output: 0 },
        timestamp,
        metadata,
      };
    case "Notification":
      return {
        type: "notification",
        level: "info",
        message:
          stringField(payload.message) ||
          stringField(payload.notification_type) ||
          stringField(payload.notificationType),
        timestamp,
        metadata,
      };
    case "BeforeTool":
      return resolveBeforeTool(toolName, toolInput, cwd, timestamp, metadata);
    case "AfterTool":
      return resolveAfterTool(toolName, toolInput, toolResponse, cwd, timestamp, metadata);
    default:
      return null;
  }
}

/**
 * Execute configured ai-hooks for a Gemini CLI command hook.
 *
 * Gemini CLI passes hook payloads as JSON on stdin and reads a JSON decision
 * from stdout (`{"decision":"deny","reason":"..."}`) with exit code 0.
 */
export async function runGeminiHook(io: HookRunnerIO = {}): Promise<number> {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  try {
    const raw = await readStdinText(io.stdin);
    const payload = parseGeminiPayload(raw);
    const nativeEvent =
      stringField(payload.hook_event_name) ||
      stringField(payload.hookEventName) ||
      stringField(env.GEMINI_HOOK_EVENT);
    const event = buildGeminiEvent(nativeEvent, payload);
    if (!event) return 0;

    const config = io.config ?? (await loadConfig(undefined, io.cwd));
    const engine = new HookEngine(config);
    const results = await engine.emit(event, { name: "gemini-cli", version: "1.0" });
    const blocked = results.find((result) => result.blocked);
    if (blocked && BLOCKING_GEMINI_EVENTS.has(nativeEvent)) {
      stdout.write(
        JSON.stringify({
          decision: "deny",
          reason: blocked.reason ?? "Blocked by ai-hooks",
        }),
      );
      return 0;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[ai-hooks] Error: ${message}\n`);
    return 0;
  }
}

function resolveTimestamp(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function isGeminiMcpTool(toolName: string): boolean {
  return toolName.startsWith("mcp_") || toolName.includes("__");
}

function parseMcpServerMethod(
  toolName: string,
  input: Record<string, unknown>,
): { server: string; method: string } {
  if (toolName.includes("__")) {
    const [serverPart, ...rest] = toolName.split("__");
    const server = serverPart?.replace(/^mcp_/, "") || "unknown";
    const method = rest.join("__") || toolName;
    return {
      server: stringField(input.server) || server,
      method: stringField(input.method) || method,
    };
  }
  if (toolName.startsWith("mcp_")) {
    const remainder = toolName.slice(4);
    const sepIdx = remainder.indexOf("_");
    if (sepIdx > 0) {
      return {
        server: stringField(input.server) || remainder.slice(0, sepIdx),
        method: stringField(input.method) || remainder.slice(sepIdx + 1) || toolName,
      };
    }
    return {
      server: stringField(input.server) || remainder || "unknown",
      method: stringField(input.method) || toolName,
    };
  }
  return {
    server: stringField(input.server) || "unknown",
    method: stringField(input.method) || toolName,
  };
}

function filePathFrom(toolInput: Record<string, unknown>): string {
  return (
    stringField(toolInput.file_path) ||
    stringField(toolInput.path) ||
    stringField(toolInput.absolute_path) ||
    stringField(toolInput.target_file)
  );
}

function resolveBeforeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  timestamp: number,
  metadata: Record<string, unknown>,
): HookEvent {
  if (isGeminiMcpTool(toolName)) {
    const { server, method } = parseMcpServerMethod(toolName, toolInput);
    return {
      type: "mcp:before",
      server,
      method,
      params: toolInput.params !== undefined ? asRecord(toolInput.params) : toolInput,
      timestamp,
      metadata,
    };
  }

  switch (toolName) {
    case "run_shell_command":
      return {
        type: "shell:before",
        command: stringField(toolInput.command),
        cwd: stringField(toolInput.directory) || stringField(toolInput.cwd, cwd),
        timestamp,
        metadata,
      };
    case "write_file":
      return {
        type: "file:write",
        path: filePathFrom(toolInput),
        content: stringField(toolInput.content),
        timestamp,
        metadata,
      };
    case "replace":
      return {
        type: "file:edit",
        path: filePathFrom(toolInput),
        oldContent: stringField(toolInput.old_string) || stringField(toolInput.oldContent),
        newContent: stringField(toolInput.new_string) || stringField(toolInput.newContent),
        timestamp,
        metadata,
      };
    case "read_file":
      return {
        type: "file:read",
        path: filePathFrom(toolInput),
        timestamp,
        metadata,
      };
    case "delete_file":
      return {
        type: "file:delete",
        path: filePathFrom(toolInput),
        timestamp,
        metadata,
      };
    default:
      return {
        type: "tool:before",
        toolName: toolName || "unknown",
        input: toolInput,
        timestamp,
        metadata,
      };
  }
}

function resolveAfterTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
  cwd: string,
  timestamp: number,
  metadata: Record<string, unknown>,
): HookEvent {
  if (isGeminiMcpTool(toolName)) {
    const { server, method } = parseMcpServerMethod(toolName, asRecord(toolResponse));
    return {
      type: "mcp:after",
      server,
      method,
      params: toolInput,
      result: toolResponse,
      duration: 0,
      timestamp,
      metadata,
    };
  }

  if (toolName === "run_shell_command") {
    const result = asRecord(toolResponse);
    return {
      type: "shell:after",
      command: stringField(toolInput.command),
      cwd: stringField(toolInput.directory) || stringField(toolInput.cwd, cwd),
      exitCode:
        typeof result.exitCode === "number"
          ? result.exitCode
          : typeof result.exit_code === "number"
            ? result.exit_code
            : 0,
      stdout: stringField(result.stdout) || stringField(result.output),
      stderr: stringField(result.stderr),
      duration: 0,
      timestamp,
      metadata,
    };
  }

  return {
    type: "tool:after",
    toolName: toolName || "unknown",
    input: toolInput,
    output: toolResponse,
    duration: 0,
    timestamp,
    metadata,
  };
}
