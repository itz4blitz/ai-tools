import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "../config/index.js";
import { HookEngine } from "../runtime/index.js";
import { BaseAdapter, registry } from "./index.js";
import {
  asRecord,
  buildCompatEvent,
  collectNativeEvents,
  isBlockingNativeEvent,
  parseHookGroups,
  payloadEventName,
  type NativeHookGroup,
} from "./claude-compat.js";
import { parseCompatPayload, readStdinText, type HookRunnerIO } from "./grok-runner.js";
import type {
  AdapterCapabilities,
  GeneratedConfig,
  HookDefinition,
  HookEventType,
} from "../types/index.js";

/**
 * Event mapping: ai-hooks universal events -> Continue native hooks (Claude Code-compatible).
 */
const EVENT_MAP: Record<string, string[]> = {
  "session:start": ["SessionStart"],
  "session:end": ["SessionEnd"],
  "prompt:submit": ["UserPromptSubmit"],
  "prompt:response": ["Stop"],
  "tool:before": ["PreToolUse"],
  "tool:after": ["PostToolUse"],
  "file:read": ["PreToolUse"],
  "file:write": ["PreToolUse"],
  "file:edit": ["PreToolUse"],
  "file:delete": ["PreToolUse"],
  "shell:before": ["PreToolUse"],
  "shell:after": ["PostToolUse"],
  "mcp:before": ["PreToolUse"],
  "mcp:after": ["PostToolUse"],
  notification: ["Notification"],
};

const REVERSE_MAP: Record<string, HookEventType[]> = {
  SessionStart: ["session:start"],
  SessionEnd: ["session:end"],
  UserPromptSubmit: ["prompt:submit"],
  Stop: ["prompt:response", "session:end"],
  PreToolUse: [
    "tool:before",
    "file:read",
    "file:write",
    "file:edit",
    "file:delete",
    "shell:before",
    "mcp:before",
  ],
  PermissionRequest: ["tool:before"],
  PostToolUse: ["tool:after", "shell:after", "mcp:after"],
  PostToolUseFailure: ["tool:after"],
  Notification: ["notification"],
};

const SETTINGS_JSON = ".continue/settings.json";
const RUNNER_JS = ".continue/hooks/ai-tools-hooks-runner.js";
const LEGACY_RUNNER_JS = ".continue/hooks/ai-hooks-runner.js";

/**
 * Execute configured ai-hooks for a Continue command hook using claude-compat payload parsing.
 * Blocking events deny with exit code 2 and reason on stderr.
 */
export async function runContinueHook(io: HookRunnerIO = {}): Promise<number> {
  const env = io.env ?? process.env;
  const stderr = io.stderr ?? process.stderr;

  try {
    const raw = await readStdinText(io.stdin);
    const payload = parseCompatPayload(raw);
    const nativeEvent = payloadEventName(payload, env.CONTINUE_HOOK_EVENT ?? env.CLAUDE_HOOK_EVENT);
    const event = buildCompatEvent(nativeEvent, payload, "continue");
    if (!event) return 0;

    const config = io.config ?? (await loadConfig(undefined, io.cwd));
    const engine = new HookEngine(config);
    const results = await engine.emit(event, { name: "continue", version: "1.0" });
    const blocked = results.find((result) => result.blocked);
    if (blocked && isBlockingNativeEvent(nativeEvent)) {
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

class ContinueAdapter extends BaseAdapter {
  readonly id = "continue";
  readonly name = "Continue";
  readonly version = "1.0";

  readonly capabilities: AdapterCapabilities = {
    beforeHooks: true,
    afterHooks: true,
    mcp: true,
    configFile: true,
    supportedEvents: [
      "session:start",
      "session:end",
      "prompt:submit",
      "prompt:response",
      "tool:before",
      "tool:after",
      "file:read",
      "file:write",
      "file:edit",
      "file:delete",
      "shell:before",
      "shell:after",
      "mcp:before",
      "mcp:after",
      "notification",
    ],
    blockableEvents: [
      "prompt:submit",
      "tool:before",
      "file:read",
      "file:write",
      "file:edit",
      "file:delete",
      "shell:before",
      "mcp:before",
    ],
  };

  async detect(): Promise<boolean> {
    if (await this.commandExists("cn")) return true;
    if (existsSync(resolve(process.cwd(), ".continue"))) return true;
    return false;
  }

  async generate(hooks: HookDefinition[]): Promise<GeneratedConfig[]> {
    const nativeEvents = collectNativeEvents(hooks, (event) => this.mapEvent(event));
    const groups = this.buildGroups(nativeEvents);
    const settings = await this.mergeSettings(groups);

    return [
      {
        path: RUNNER_JS,
        content: this.generateRunner(),
        format: "js",
      },
      {
        path: SETTINGS_JSON,
        content: `${JSON.stringify(settings, null, 2)}\n`,
        format: "json",
      },
    ];
  }

  async import(cwd?: string): Promise<HookDefinition[]> {
    const dir = cwd ?? process.cwd();
    const data = await this.readJsonRecord(resolve(dir, SETTINGS_JSON));
    const hooks = asRecord(data.hooks);
    const imported: HookDefinition[] = [];
    for (const [nativeEvent, groups] of Object.entries(hooks)) {
      imported.push(
        ...parseHookGroups(groups, nativeEvent, (event) => this.mapNativeEvent(event), "continue"),
      );
    }
    return imported;
  }

  mapEvent(event: HookEventType): string[] {
    return EVENT_MAP[event] ?? [];
  }

  mapNativeEvent(nativeEvent: string): HookEventType[] {
    return REVERSE_MAP[nativeEvent] ?? [];
  }

  override async uninstall(): Promise<void> {
    await this.removeFile(LEGACY_RUNNER_JS);
    await this.removeFile(RUNNER_JS);
    await this.stripSettings();
  }

  private buildGroups(nativeEvents: string[]): Record<string, NativeHookGroup[]> {
    const runnerAbsPath = resolve(process.cwd(), RUNNER_JS);
    const command = `node ${JSON.stringify(runnerAbsPath)}`;
    const groups: Record<string, NativeHookGroup[]> = {};

    for (const nativeEvent of nativeEvents) {
      const group: NativeHookGroup = {
        hooks: [
          {
            type: "command",
            command,
            timeout: 30,
            statusMessage: `ai-hooks: ${nativeEvent}`,
          },
        ],
      };

      if (nativeEvent === "PreToolUse" || nativeEvent === "PostToolUse") {
        group.matcher = "*";
      }

      groups[nativeEvent] = [group];
    }

    return groups;
  }

  private async mergeSettings(
    groups: Record<string, NativeHookGroup[]>,
  ): Promise<Record<string, unknown>> {
    const existing = await this.readJsonRecord(resolve(process.cwd(), SETTINGS_JSON));
    const existingHooks = asRecord(existing.hooks);
    const mergedHooks: Record<string, unknown> = {};

    for (const [event, entries] of Object.entries(existingHooks)) {
      const kept = stripAiHooksGroups(entries);
      if (kept.length > 0) {
        mergedHooks[event] = kept;
      }
    }

    for (const [event, entries] of Object.entries(groups)) {
      const current = Array.isArray(mergedHooks[event]) ? mergedHooks[event] : [];
      mergedHooks[event] = [...current, ...entries];
    }

    return {
      ...existing,
      hooks: mergedHooks,
    };
  }

  private async stripSettings(): Promise<void> {
    const fullPath = resolve(process.cwd(), SETTINGS_JSON);
    if (!existsSync(fullPath)) return;

    const existing = await this.readJsonRecord(fullPath);
    if (Object.keys(existing).length === 0) return;

    const existingHooks = asRecord(existing.hooks);
    const stripped: Record<string, unknown> = {};
    for (const [event, entries] of Object.entries(existingHooks)) {
      const kept = stripAiHooksGroups(entries);
      if (kept.length > 0) {
        stripped[event] = kept;
      }
    }

    const next: Record<string, unknown> = { ...existing };
    if (Object.keys(stripped).length > 0) {
      next.hooks = stripped;
    } else {
      delete next.hooks;
    }

    await this.writeJsonFile(SETTINGS_JSON, next);
  }

  private async readJsonRecord(fullPath: string): Promise<Record<string, unknown>> {
    if (!existsSync(fullPath)) return {};
    try {
      const parsed: unknown = JSON.parse(await readFile(fullPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }

  private generateRunner(): string {
    return `#!/usr/bin/env node
/**
 * ai-hooks runner for Continue.
 * Generated by: ai-hooks generate
 *
 * Continue passes Claude Code-compatible hook event data as JSON via STDIN.
 * Blocking events deny with exit code 2 and feedback on STDERR.
 *
 * DO NOT EDIT - regenerate with: ai-hooks generate
 */
import { loadConfig, HookEngine } from "@itz4blitz/ai-tools-hooks";

const PROJECT_ROOT = ${JSON.stringify(resolve(process.cwd()))};
process.chdir(PROJECT_ROOT);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function normalizeEventName(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (trimmed.includes("_")) {
    return trimmed
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join("");
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function isMcpTool(toolName) {
  return toolName.includes("__") || toolName === "CallMcpTool" || toolName === "use_tool";
}

function resolvePreTool(toolName, toolInput, cwd, timestamp, metadata) {
  if (isMcpTool(toolName)) {
    const parts = toolName.split("__");
    return {
      type: "mcp:before",
      server: toolInput.server || parts[0] || "unknown",
      method: toolInput.method || parts[1] || toolName,
      params: toolInput.params ?? toolInput,
      timestamp,
      metadata,
    };
  }
  switch (toolName) {
    case "Bash":
    case "run_terminal_command":
    case "run_terminal_cmd":
      return {
        type: "shell:before",
        command: toolInput.command || "",
        cwd: toolInput.cwd || cwd,
        timestamp,
        metadata,
      };
    case "Write":
      return {
        type: "file:write",
        path: toolInput.file_path || toolInput.path || "",
        content: toolInput.content || "",
        timestamp,
        metadata,
      };
    case "Edit":
    case "MultiEdit":
    case "search_replace":
      return {
        type: "file:edit",
        path: toolInput.file_path || toolInput.path || "",
        oldContent: toolInput.old_string || toolInput.oldContent || "",
        newContent: toolInput.new_string || toolInput.newContent || "",
        timestamp,
        metadata,
      };
    case "Delete":
    case "delete_file":
      return {
        type: "file:delete",
        path: toolInput.file_path || toolInput.path || "",
        timestamp,
        metadata,
      };
    case "Read":
    case "read_file":
      return {
        type: "file:read",
        path: toolInput.file_path || toolInput.path || "",
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

function resolvePostTool(toolName, toolInput, toolResult, cwd, timestamp, metadata) {
  if (isMcpTool(toolName)) {
    const parts = toolName.split("__");
    return {
      type: "mcp:after",
      server: (toolResult && toolResult.server) || parts[0] || "unknown",
      method: (toolResult && toolResult.method) || parts[1] || toolName,
      params: toolInput,
      result: toolResult,
      duration: 0,
      timestamp,
      metadata,
    };
  }
  if (toolName === "Bash" || toolName === "run_terminal_command" || toolName === "run_terminal_cmd") {
    return {
      type: "shell:after",
      command: toolInput.command || "",
      cwd: toolInput.cwd || cwd,
      exitCode: typeof toolResult.exitCode === "number" ? toolResult.exitCode : 0,
      stdout: toolResult.stdout || "",
      stderr: toolResult.stderr || "",
      duration: 0,
      timestamp,
      metadata,
    };
  }
  return {
    type: "tool:after",
    toolName: toolName || "unknown",
    input: toolInput,
    output: toolResult,
    duration: 0,
    timestamp,
    metadata,
  };
}

function buildEvent(nativeEvent, payload) {
  const timestamp = Date.now();
  const metadata = { nativeEvent, payload };
  const cwd = payload.cwd || payload.workspaceRoot || process.cwd();
  const toolName = payload.toolName || payload.tool_name || "";
  const toolInput = payload.toolInput || payload.tool_input || {};
  const toolResult = payload.toolResult ?? payload.tool_response ?? {};

  switch (nativeEvent) {
    case "SessionStart":
      return {
        type: "session:start",
        tool: "continue",
        version: "1.0",
        workingDirectory: cwd,
        timestamp,
        metadata,
      };
    case "SessionEnd":
      return { type: "session:end", tool: "continue", duration: 0, timestamp, metadata };
    case "UserPromptSubmit":
      return {
        type: "prompt:submit",
        prompt: payload.prompt || toolInput.prompt || "",
        timestamp,
        metadata,
      };
    case "Notification":
      return {
        type: "notification",
        level: "info",
        message: payload.message || payload.notificationType || "",
        timestamp,
        metadata,
      };
    case "PreToolUse":
    case "PermissionRequest":
      return resolvePreTool(toolName, toolInput, cwd, timestamp, metadata);
    case "PostToolUse":
    case "PostToolUseFailure":
      return resolvePostTool(toolName, toolInput, toolResult, cwd, timestamp, metadata);
    case "Stop":
      if (typeof payload.lastAssistantMessage === "string" && payload.lastAssistantMessage) {
        return {
          type: "prompt:response",
          response: payload.lastAssistantMessage,
          model: "continue",
          tokens: { input: 0, output: 0 },
          timestamp,
          metadata,
        };
      }
      return { type: "session:end", tool: "continue", duration: 0, timestamp, metadata };
    default:
      return null;
  }
}

async function run() {
  let payload = {};
  try {
    const raw = await readStdin();
    payload = JSON.parse(raw || "{}");
  } catch {
    payload = {};
  }

  const nativeEvent = normalizeEventName(
    payload.hookEventName ||
      payload.hook_event_name ||
      process.env.CONTINUE_HOOK_EVENT ||
      process.env.CLAUDE_HOOK_EVENT ||
      "",
  );
  const event = buildEvent(nativeEvent, payload);
  if (!event) {
    process.exit(0);
  }

  const config = await loadConfig();
  const engine = new HookEngine(config);
  const results = await engine.emit(event, { name: "continue", version: "1.0" });
  const blocked = results.find((r) => r.blocked);
  const blocking =
    nativeEvent === "PreToolUse" ||
    nativeEvent === "UserPromptSubmit" ||
    nativeEvent === "PermissionRequest";

  if (blocked && blocking) {
    process.stderr.write(blocked.reason ?? "Blocked by ai-hooks");
    process.exit(2);
  }
}

run().catch((err) => {
  console.error("[ai-hooks] Error:", err.message);
  process.exit(0);
});
`;
  }
}

function stripAiHooksGroups(entries: unknown): NativeHookGroup[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => {
    const group = asRecord(entry);
    const hooks = group.hooks;
    if (!Array.isArray(hooks)) return true;
    return !hooks.some((hook) => {
      const command = asRecord(hook).command;
      return (
        typeof command === "string" &&
        (command.includes("ai-tools-hooks-runner") || command.includes("ai-hooks-runner"))
      );
    });
  }) as NativeHookGroup[];
}

const adapter = new ContinueAdapter();
registry.register(adapter);

export { ContinueAdapter };
export default adapter;
