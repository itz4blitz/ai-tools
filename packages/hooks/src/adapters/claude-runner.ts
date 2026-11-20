import { loadConfig } from "../config/index.js";
import { HookEngine } from "../runtime/index.js";
import { buildCompatEvent, payloadEventName, type CompatPayload } from "./claude-compat.js";
import { parseCompatPayload, readStdinText, type HookRunnerIO } from "./grok-runner.js";

function normalizeClaudePayload(payload: CompatPayload): CompatPayload {
  const normalized: CompatPayload = { ...payload };
  if (
    normalized.lastAssistantMessage === undefined &&
    typeof payload.last_assistant_message === "string"
  ) {
    normalized.lastAssistantMessage = payload.last_assistant_message;
  }
  if (normalized.notificationType === undefined && typeof payload.notification_type === "string") {
    normalized.notificationType = payload.notification_type;
  }
  return normalized;
}

/**
 * Execute configured ai-hooks for a Claude Code command hook.
 *
 * Claude Code sends JSON on stdin (`hook_event_name`, `tool_name`, `tool_input`,
 * `tool_response`, `cwd`, `prompt`, `session_id`, etc.) and reads structured JSON
 * from stdout on exit 0:
 * - PreToolUse block: `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason } }`
 * - PermissionRequest block: `{ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } } }`
 * - Stop / UserPromptSubmit block: `{ decision: "block", reason }`
 * - Additional context: `{ hookSpecificOutput: { hookEventName, additionalContext } }`
 */
export async function runClaudeCodeHook(io: HookRunnerIO = {}): Promise<number> {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  try {
    const raw = await readStdinText(io.stdin);
    const payload = normalizeClaudePayload(parseCompatPayload(raw));
    const nativeEvent = payloadEventName(payload, env.CLAUDE_HOOK_EVENT);
    const event = buildCompatEvent(nativeEvent, payload, "claude-code");
    if (!event) return 0;

    if (typeof payload.session_id === "string" && payload.session_id) {
      event.metadata.sessionId = payload.session_id;
    } else if (typeof payload.sessionId === "string" && payload.sessionId) {
      event.metadata.sessionId = payload.sessionId;
    }

    const config = io.config ?? (await loadConfig(undefined, io.cwd));
    const engine = new HookEngine(config);
    const results = await engine.emit(event, { name: "claude-code", version: "1.0" });

    const blocked = results.find((result) => result.blocked);
    if (blocked) {
      const reason = blocked.reason ?? "Blocked by ai-hooks";
      if (nativeEvent === "PreToolUse") {
        stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          }),
        );
        return 0;
      }
      if (nativeEvent === "PermissionRequest") {
        stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: {
                behavior: "deny",
                message: reason,
              },
            },
          }),
        );
        return 0;
      }
      if (nativeEvent === "Stop" || nativeEvent === "UserPromptSubmit") {
        stdout.write(
          JSON.stringify({
            decision: "block",
            reason,
          }),
        );
        return 0;
      }
    }

    const note = results.find(
      (result) =>
        typeof result.data?.additionalContext === "string" &&
        result.data.additionalContext.length > 0,
    );
    if (note && typeof note.data?.additionalContext === "string") {
      stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: nativeEvent,
            additionalContext: note.data.additionalContext,
          },
        }),
      );
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[ai-hooks] Error: ${message}\n`);
    return 0;
  }
}
