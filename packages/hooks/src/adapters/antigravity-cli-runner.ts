import { loadConfig } from "../config/index.js";
import { HookEngine } from "../runtime/index.js";
import type { HookEvent } from "../types/index.js";
import { asRecord, stringField } from "./claude-compat.js";
import { readStdinText, type HookRunnerIO } from "./grok-runner.js";

export type AntigravityHookPayload = {
  hookEventName?: string;
  cwd?: string;
  toolCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
  toolResult?: unknown;
  lastUserInput?: string;
  lastAssistantMessage?: string;
  error?: unknown;
  terminationReason?: string;
  timestamp?: string | number;
  [key: string]: unknown;
};

function parsePayload(raw: string): AntigravityHookPayload {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return asRecord(parsed) as AntigravityHookPayload;
  } catch {
    return {};
  }
}

function payloadTimestamp(payload: AntigravityHookPayload): number {
  if (typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)) {
    return payload.timestamp;
  }
  if (typeof payload.timestamp === "string") {
    const parsed = Date.parse(payload.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function filePathFrom(args: Record<string, unknown>): string {
  return (
    stringField(args.Path) ||
    stringField(args.TargetFile) ||
    stringField(args.AbsolutePath) ||
    stringField(args.file_path) ||
    stringField(args.path) ||
    stringField(args.target_file)
  );
}

function parseMcpTool(toolName: string): { server: string; method: string } | null {
  if (toolName.startsWith("mcp_")) {
    const rest = toolName.slice(4);
    const sepIdx = rest.indexOf("_");
    if (sepIdx === -1) {
      return { server: rest || "unknown", method: toolName };
    }
    return {
      server: rest.slice(0, sepIdx) || "unknown",
      method: rest.slice(sepIdx + 1) || toolName,
    };
  }
  if (toolName.includes("__")) {
    const [server, ...methodParts] = toolName.split("__");
    return {
      server: server || "unknown",
      method: methodParts.join("__") || toolName,
    };
  }
  return null;
}

function resolvePreToolUse(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  timestamp: number,
  metadata: Record<string, unknown>,
): HookEvent {
  const mcp = parseMcpTool(toolName);
  if (mcp) {
    return {
      type: "mcp:before",
      server: stringField(args.server) || mcp.server,
      method: stringField(args.method) || mcp.method,
      params: args.params !== undefined ? asRecord(args.params) : args,
      timestamp,
      metadata,
    };
  }

  switch (toolName) {
    case "run_command":
      return {
        type: "shell:before",
        command: stringField(args.CommandLine) || stringField(args.command),
        cwd: stringField(args.Cwd) || stringField(args.cwd) || cwd,
        timestamp,
        metadata,
      };
    case "write_to_file":
    case "write_file":
      return {
        type: "file:write",
        path: filePathFrom(args),
        content:
          stringField(args.CodeContent) || stringField(args.Content) || stringField(args.content),
        timestamp,
        metadata,
      };
    case "edit_file":
      return {
        type: "file:edit",
        path: filePathFrom(args),
        oldContent:
          stringField(args.Target) || stringField(args.oldContent) || stringField(args.old_string),
        newContent:
          stringField(args.Replacement) ||
          stringField(args.newContent) ||
          stringField(args.new_string),
        timestamp,
        metadata,
      };
    case "read_file":
    case "view_file":
      return {
        type: "file:read",
        path: filePathFrom(args),
        timestamp,
        metadata,
      };
    default:
      return {
        type: "tool:before",
        toolName: toolName || "unknown",
        input: args,
        timestamp,
        metadata,
      };
  }
}

function resolvePostToolUse(
  toolName: string,
  args: Record<string, unknown>,
  toolResult: unknown,
  cwd: string,
  timestamp: number,
  metadata: Record<string, unknown>,
): HookEvent {
  const mcp = parseMcpTool(toolName);
  if (mcp) {
    const resultRecord = asRecord(toolResult);
    return {
      type: "mcp:after",
      server: stringField(resultRecord.server) || mcp.server,
      method: stringField(resultRecord.method) || mcp.method,
      params: args,
      result: toolResult,
      duration: 0,
      timestamp,
      metadata,
    };
  }

  if (toolName === "run_command") {
    const resultRecord = asRecord(toolResult);
    return {
      type: "shell:after",
      command: stringField(args.CommandLine) || stringField(args.command),
      cwd: stringField(args.Cwd) || stringField(args.cwd) || cwd,
      exitCode: typeof resultRecord.exitCode === "number" ? resultRecord.exitCode : 0,
      stdout: stringField(resultRecord.stdout),
      stderr: stringField(resultRecord.stderr),
      duration: 0,
      timestamp,
      metadata,
    };
  }

  return {
    type: "tool:after",
    toolName: toolName || "unknown",
    input: args,
    output: toolResult,
    duration: 0,
    timestamp,
    metadata,
  };
}

export function buildAntigravityEvent(
  nativeEvent: string,
  payload: AntigravityHookPayload,
): HookEvent | null {
  const timestamp = payloadTimestamp(payload);
  const cwd = stringField(payload.cwd) || process.cwd();
  const toolCall = asRecord(payload.toolCall);
  const toolName = stringField(toolCall.name);
  const toolArgs = asRecord(toolCall.args);
  const metadata: Record<string, unknown> = {
    nativeEvent,
    payload,
    ...(toolCall.id !== undefined ? { toolCallId: toolCall.id } : {}),
    ...(payload.error !== undefined ? { error: payload.error } : {}),
    ...(payload.terminationReason !== undefined
      ? { terminationReason: payload.terminationReason }
      : {}),
  };

  switch (nativeEvent) {
    case "SessionStart":
      return {
        type: "session:start",
        tool: "antigravity-cli",
        version: "1.0",
        workingDirectory: cwd,
        timestamp,
        metadata,
      };
    case "PreInvocation":
      return {
        type: "prompt:submit",
        prompt: stringField(payload.lastUserInput),
        timestamp,
        metadata,
      };
    case "PostInvocation":
      return {
        type: "prompt:response",
        response: stringField(payload.lastAssistantMessage),
        model: "antigravity-cli",
        tokens: { input: 0, output: 0 },
        timestamp,
        metadata,
      };
    case "Stop":
      return {
        type: "session:end",
        tool: "antigravity-cli",
        duration: 0,
        timestamp,
        metadata,
      };
    case "PreToolUse":
      return resolvePreToolUse(toolName, toolArgs, cwd, timestamp, metadata);
    case "PostToolUse":
      return resolvePostToolUse(
        toolName,
        toolArgs,
        payload.toolResult ?? {},
        cwd,
        timestamp,
        metadata,
      );
    default:
      return null;
  }
}

/**
 * Execute configured ai-hooks for an Antigravity CLI command hook.
 * Reads camelCase JSON from stdin and writes Antigravity CLI hook JSON to stdout.
 */
export async function runAntigravityCliHook(io: HookRunnerIO = {}): Promise<number> {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  try {
    const raw = await readStdinText(io.stdin);
    const payload = parsePayload(raw);
    const nativeEvent = (
      stringField(payload.hookEventName) || stringField(env.ANTIGRAVITY_HOOK_EVENT)
    ).trim();

    const event = buildAntigravityEvent(nativeEvent, payload);
    if (!event) {
      stdout.write(JSON.stringify({}));
      return 0;
    }

    const config = io.config ?? (await loadConfig(undefined, io.cwd));
    const engine = new HookEngine(config);
    const results = await engine.emit(event, { name: "antigravity-cli", version: "1.0" });
    const blocked = results.find((result) => result.blocked);
    const reason = blocked?.reason ?? "Blocked by ai-hooks";

    if (nativeEvent === "PreToolUse") {
      if (blocked) {
        stdout.write(JSON.stringify({ decision: "deny", reason }));
      } else {
        stdout.write(JSON.stringify({ decision: "allow" }));
      }
      return 0;
    }

    if (nativeEvent === "PostToolUse") {
      stdout.write(JSON.stringify({}));
      return 0;
    }

    if (nativeEvent === "PreInvocation" && blocked) {
      stdout.write(
        JSON.stringify({
          terminationBehavior: "terminate",
          injectSteps: [{ type: "USER_MESSAGE", content: reason }],
        }),
      );
      return 0;
    }

    if (nativeEvent === "Stop" && blocked) {
      stdout.write(JSON.stringify({ decision: "continue", reason }));
      return 0;
    }

    stdout.write(JSON.stringify({}));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[ai-hooks] Error: ${message}\n`);
    stdout.write(JSON.stringify({}));
    return 0;
  }
}
