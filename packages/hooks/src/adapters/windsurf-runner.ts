import { loadConfig } from "../config/index.js";
import { HookEngine } from "../runtime/index.js";
import type { HookEvent } from "../types/index.js";
import { asRecord, stringField } from "./claude-compat.js";
import { readStdinText, type HookRunnerIO } from "./grok-runner.js";

export type WindsurfHookRunnerIO = HookRunnerIO & {
  argv?: string[];
};

export type WindsurfPayload = {
  agent_action_name?: string;
  hook_event_name?: string;
  hookEventName?: string;
  trajectory_id?: string;
  execution_id?: string;
  timestamp?: string | number;
  tool_info?: Record<string, unknown>;
  [key: string]: unknown;
};

const BLOCKING_EVENTS = new Set([
  "pre_user_prompt",
  "pre_read_code",
  "pre_write_code",
  "pre_run_command",
  "pre_mcp_tool_use",
]);

export function isWindsurfBlockingEvent(nativeEvent: string): boolean {
  return BLOCKING_EVENTS.has(nativeEvent);
}

function parseWindsurfPayload(raw: string): WindsurfPayload {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return asRecord(parsed) as WindsurfPayload;
  } catch {
    return {};
  }
}

function resolveTimestamp(payload: WindsurfPayload): number {
  if (typeof payload.timestamp === "number" && Number.isFinite(payload.timestamp)) {
    return payload.timestamp;
  }
  if (typeof payload.timestamp === "string") {
    const parsed = Date.parse(payload.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function resolveNativeEvent(
  payload: WindsurfPayload,
  argv: string[],
  env: NodeJS.ProcessEnv,
): string {
  return (
    stringField(payload.agent_action_name) ||
    stringField(payload.hook_event_name) ||
    stringField(payload.hookEventName) ||
    stringField(argv[2]) ||
    stringField(env.WINDSURF_HOOK_EVENT)
  ).trim();
}

function firstEdit(toolInfo: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(toolInfo.edits) || toolInfo.edits.length === 0) return undefined;
  return asRecord(toolInfo.edits[0]);
}

export function buildWindsurfEvent(
  nativeEvent: string,
  payload: WindsurfPayload,
  fallbackCwd?: string,
): HookEvent | null {
  const toolInfo = asRecord(payload.tool_info);
  const timestamp = resolveTimestamp(payload);
  const metadata: Record<string, unknown> = { nativeEvent, payload };
  const cwd = stringField(toolInfo.cwd) || stringField(payload.cwd) || fallbackCwd || process.cwd();

  switch (nativeEvent) {
    case "pre_user_prompt":
      return {
        type: "prompt:submit",
        prompt:
          stringField(toolInfo.user_prompt) ||
          stringField(payload.user_prompt) ||
          stringField(payload.prompt),
        timestamp,
        metadata,
      };
    case "pre_read_code":
      return {
        type: "file:read",
        path: stringField(toolInfo.file_path) || stringField(payload.file_path),
        timestamp,
        metadata,
      };
    case "pre_write_code": {
      const path = stringField(toolInfo.file_path) || stringField(payload.file_path);
      const edit = firstEdit(toolInfo);
      if (edit || toolInfo.old_string !== undefined) {
        return {
          type: "file:edit",
          path,
          oldContent: stringField(edit?.old_string) || stringField(toolInfo.old_string),
          newContent: stringField(edit?.new_string) || stringField(toolInfo.new_string),
          timestamp,
          metadata,
        };
      }
      return {
        type: "file:write",
        path,
        content: stringField(toolInfo.content) || stringField(toolInfo.new_string),
        timestamp,
        metadata,
      };
    }
    case "post_write_code": {
      const path = stringField(toolInfo.file_path) || stringField(payload.file_path);
      const edit = firstEdit(toolInfo);
      return {
        type: "file:edit",
        path,
        oldContent: stringField(edit?.old_string) || stringField(toolInfo.old_string),
        newContent:
          stringField(edit?.new_string) ||
          stringField(toolInfo.new_string) ||
          stringField(toolInfo.content),
        timestamp,
        metadata,
      };
    }
    case "pre_run_command":
      return {
        type: "shell:before",
        command:
          stringField(toolInfo.command_line) ||
          stringField(toolInfo.command) ||
          stringField(payload.command_line) ||
          stringField(payload.command),
        cwd,
        timestamp,
        metadata,
      };
    case "post_run_command":
      return {
        type: "shell:after",
        command:
          stringField(toolInfo.command_line) ||
          stringField(toolInfo.command) ||
          stringField(payload.command_line) ||
          stringField(payload.command),
        cwd,
        exitCode: typeof toolInfo.exit_code === "number" ? toolInfo.exit_code : 0,
        stdout: stringField(toolInfo.stdout),
        stderr: stringField(toolInfo.stderr),
        duration: 0,
        timestamp,
        metadata,
      };
    case "pre_mcp_tool_use":
      return {
        type: "mcp:before",
        server: stringField(toolInfo.mcp_server_name) || stringField(toolInfo.server) || "unknown",
        method: stringField(toolInfo.mcp_tool_name) || stringField(toolInfo.method) || "unknown",
        params: asRecord(toolInfo.mcp_tool_arguments ?? toolInfo.params),
        timestamp,
        metadata,
      };
    case "post_mcp_tool_use":
      return {
        type: "mcp:after",
        server: stringField(toolInfo.mcp_server_name) || stringField(toolInfo.server) || "unknown",
        method: stringField(toolInfo.mcp_tool_name) || stringField(toolInfo.method) || "unknown",
        params: asRecord(toolInfo.mcp_tool_arguments ?? toolInfo.params),
        result: toolInfo.mcp_result ?? toolInfo.result ?? {},
        duration: 0,
        timestamp,
        metadata,
      };
    default:
      return null;
  }
}

/**
 * Execute configured ai-hooks for a Windsurf Cascade hook.
 * Windsurf blocks pre_* actions when the hook exits with code 2.
 */
export async function runWindsurfHook(io: WindsurfHookRunnerIO = {}): Promise<number> {
  const env = io.env ?? process.env;
  const argv = io.argv ?? process.argv;
  const stderr = io.stderr ?? process.stderr;

  try {
    const raw = await readStdinText(io.stdin);
    const payload = parseWindsurfPayload(raw);
    const nativeEvent = resolveNativeEvent(payload, argv, env);
    const event = buildWindsurfEvent(nativeEvent, payload, io.cwd);
    if (!event) return 0;

    const config = io.config ?? (await loadConfig(undefined, io.cwd));
    const engine = new HookEngine(config);
    const results = await engine.emit(event, { name: "windsurf", version: "1.0" });
    const blocked = results.find((result) => result.blocked);
    if (blocked && isWindsurfBlockingEvent(nativeEvent)) {
      stderr.write(blocked.reason ?? "Blocked by ai-hooks");
      return 2;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[ai-hooks] Error: ${message}\n`);
    return 0;
  }
}
