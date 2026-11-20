import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BaseAdapter, registry } from "./index.js";
import type {
  AdapterCapabilities,
  GeneratedConfig,
  HookDefinition,
  HookEventType,
} from "../types/index.js";

/**
 * Event mapping: ai-hooks universal events -> Factory Droid native hooks.
 *
 * Droid supports nine hook events:
 *   PreToolUse, PostToolUse, UserPromptSubmit, Notification,
 *   Stop, SubagentStop, PreCompact, SessionStart, SessionEnd
 *
 * Hook input is JSON via STDIN with tool_name, tool_input, etc.
 * Exit code 2 blocks on PreToolUse, UserPromptSubmit, and Stop; STDERR is sent to Droid.
 *
 * Reference: https://docs.factory.ai/reference/hooks-reference
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
  Stop: ["prompt:response"],
  PreToolUse: [
    "tool:before",
    "file:read",
    "file:write",
    "file:edit",
    "file:delete",
    "shell:before",
    "mcp:before",
  ],
  PostToolUse: ["tool:after", "shell:after", "mcp:after"],
  Notification: ["notification"],
};

const SETTINGS_PATH = ".factory/settings.json";
const RUNNER_PATH = ".factory/hooks/ai-tools-hooks-runner.js";
const LEGACY_RUNNER_PATH = ".factory/hooks/ai-hooks-runner.js";

function isAiToolsHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) => {
    if (!hook || typeof hook !== "object" || Array.isArray(hook)) return false;
    const command = (hook as { command?: unknown }).command;
    return (
      typeof command === "string" &&
      (command.includes("ai-hooks-runner") || command.includes("ai-tools-hooks-runner"))
    );
  });
}

function asPlainObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Factory Droid adapter for ai-hooks.
 *
 * Generates `.factory/settings.json` hook entries and a runner script.
 * Droid uses a settings.json format very similar to Claude Code, with
 * hooks keyed by event name containing matcher patterns and commands.
 *
 * Hook scripts receive JSON via STDIN with session_id, cwd, tool_name,
 * tool_input, and hook_event_name. Exit code 2 blocks PreToolUse,
 * UserPromptSubmit, and Stop hooks; STDERR is processed by Droid as feedback.
 *
 * Reference: https://docs.factory.ai/cli/configuration/hooks-guide
 */
class DroidAdapter extends BaseAdapter {
  readonly id = "droid";
  readonly name = "Factory Droid";
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
      "prompt:response",
      "tool:before",
      "file:read",
      "file:write",
      "file:edit",
      "file:delete",
      "shell:before",
      "mcp:before",
    ],
  };

  async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    const hasCommand = await this.commandExists("droid");
    const hasDir = existsSync(resolve(dir, ".factory"));
    return hasCommand || hasDir;
  }

  async generate(hooks: HookDefinition[]): Promise<GeneratedConfig[]> {
    const configs: GeneratedConfig[] = [];

    // Collect needed native events
    const neededEvents = new Set<string>();
    for (const hook of hooks) {
      for (const event of hook.events) {
        const nativeEvents = this.mapEvent(event);
        for (const ne of nativeEvents) {
          neededEvents.add(ne);
        }
      }
    }

    // Generate the runner script
    configs.push({
      path: RUNNER_PATH,
      content: this.generateRunner(),
      format: "js",
    });

    // Build Droid settings hooks config
    const hooksConfig: Record<string, unknown[]> = {};
    const runnerAbsPath = resolve(process.cwd(), RUNNER_PATH);
    const runnerCommand = `node ${JSON.stringify(runnerAbsPath)}`;

    for (const event of neededEvents) {
      const hookEntry: Record<string, unknown> = {
        hooks: [
          {
            type: "command",
            command: runnerCommand,
            timeout: 30,
          },
        ],
      };

      // Tool-related events support matchers
      if (event === "PreToolUse" || event === "PostToolUse") {
        hookEntry.matcher = "*";
      }

      if (!hooksConfig[event]) {
        hooksConfig[event] = [];
      }
      hooksConfig[event].push(hookEntry);
    }

    // Merge with existing settings if present
    const settingsConfig = await this.mergeSettings(hooksConfig);

    configs.push({
      path: SETTINGS_PATH,
      content: JSON.stringify(settingsConfig, null, 2) + "\n",
      format: "json",
    });

    return configs;
  }

  mapEvent(event: HookEventType): string[] {
    return EVENT_MAP[event] ?? [];
  }

  mapNativeEvent(nativeEvent: string): HookEventType[] {
    return REVERSE_MAP[nativeEvent] ?? [];
  }

  override async uninstall(): Promise<void> {
    await this.stripSettingsHooks();
    await this.removeFile(LEGACY_RUNNER_PATH);
    await this.removeFile(RUNNER_PATH);
  }

  private async readExistingSettings(): Promise<Record<string, unknown> | null> {
    const settingsPath = resolve(process.cwd(), SETTINGS_PATH);
    if (!existsSync(settingsPath)) return null;
    try {
      const raw = await readFile(settingsPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async stripSettingsHooks(): Promise<void> {
    const existing = await this.readExistingSettings();
    if (!existing) return;

    const existingHooks = asPlainObject(existing.hooks);
    if (Object.keys(existingHooks).length === 0) return;

    const cleanedHooks: Record<string, unknown[]> = {};
    for (const [event, entries] of Object.entries(existingHooks)) {
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter((entry) => !isAiToolsHookEntry(entry));
      if (kept.length > 0) {
        cleanedHooks[event] = kept;
      }
    }

    const updated: Record<string, unknown> = { ...existing };
    if (Object.keys(cleanedHooks).length > 0) {
      updated.hooks = cleanedHooks;
    } else {
      delete updated.hooks;
    }

    await this.writeJsonFile(SETTINGS_PATH, updated);
  }

  private async mergeSettings(
    hooksConfig: Record<string, unknown[]>,
  ): Promise<Record<string, unknown>> {
    const existing = (await this.readExistingSettings()) ?? {};
    const existingHooks = asPlainObject(existing.hooks);
    const mergedHooks: Record<string, unknown[]> = {};

    // Prune stale ai-tools runner entries across ALL existing hook keys
    for (const [event, entries] of Object.entries(existingHooks)) {
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter((entry) => !isAiToolsHookEntry(entry));
      if (kept.length > 0) {
        mergedHooks[event] = kept;
      }
    }

    // Append newly generated hook entries
    for (const [event, entries] of Object.entries(hooksConfig)) {
      if (!mergedHooks[event]) {
        mergedHooks[event] = [];
      }
      mergedHooks[event].push(...entries);
    }

    return {
      ...existing,
      hooks: mergedHooks,
    };
  }

  private generateRunner(): string {
    return `#!/usr/bin/env node
/**
 * ai-hooks runner for Factory Droid.
 * Generated by: ai-hooks generate
 *
 * Droid passes hook event data as JSON via STDIN with:
 *   hook_event_name, session_id, cwd, tool_name, tool_input, tool_response
 *
 * Exit code 0 = success, exit code 2 = block (PreToolUse, UserPromptSubmit, Stop).
 * STDERR on exit code 2 is fed back to Droid as context.
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

function parseMcpTool(toolName, toolInput) {
  if (toolName.startsWith("mcp:")) {
    const rest = toolName.slice(4);
    const sepMatch = /^([^:/]+?)(?:__|:|\\/)(.+)$/.exec(rest);
    if (sepMatch) {
      return {
        server: toolInput.server ?? sepMatch[1] ?? "unknown",
        method: toolInput.method ?? sepMatch[2] ?? rest,
      };
    }
    return {
      server: toolInput.server ?? (rest || "unknown"),
      method: toolInput.method ?? toolName,
    };
  }
  const parts = toolName.split("__");
  return {
    server: toolInput.server ?? (parts[0] || "unknown"),
    method: toolInput.method ?? (parts.slice(1).join("__") || toolName),
  };
}

function isMcpTool(toolName) {
  return toolName.startsWith("mcp:") || toolName.includes("__");
}

async function run() {
  const raw = await readStdin();
  const input = JSON.parse(raw || "{}");
  const hookEventName = input.hook_event_name ?? "";
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};
  const toolResponse = input.tool_response ?? {};
  const cwd = input.cwd ?? process.cwd();

  const config = await loadConfig();
  const engine = new HookEngine(config);
  const toolInfo = { name: "droid", version: "1.0" };
  const timestamp = Date.now();
  const metadata = { sessionId: input.session_id ?? input.sessionId ?? "" };

  let event;
  switch (hookEventName) {
    case "SessionStart":
      event = {
        type: "session:start",
        tool: "droid",
        version: "1.0",
        workingDirectory: cwd,
        timestamp,
        metadata,
      };
      break;
    case "SessionEnd":
      event = { type: "session:end", tool: "droid", duration: 0, timestamp, metadata };
      break;
    case "UserPromptSubmit":
      event = {
        type: "prompt:submit",
        prompt: input.prompt ?? toolInput.prompt ?? "",
        timestamp,
        metadata,
      };
      break;
    case "Notification":
      event = {
        type: "notification",
        level: "info",
        message: input.message ?? toolInput.message ?? "",
        timestamp,
        metadata,
      };
      break;
    case "Stop":
      event = {
        type: "prompt:response",
        response:
          input.response ??
          input.last_assistant_message ??
          input.lastAssistantMessage ??
          toolInput.response ??
          "",
        model: input.model ?? "droid",
        tokens: { input: 0, output: 0 },
        timestamp,
        metadata,
      };
      break;
    case "PreToolUse":
      event = resolvePreToolEvent(toolName, toolInput, cwd, timestamp, metadata);
      break;
    case "PostToolUse":
      event = resolvePostToolEvent(toolName, toolInput, toolResponse, cwd, timestamp, metadata);
      break;
    default:
      process.exit(0);
  }

  const results = await engine.emit(event, toolInfo);
  const blocked = results.find((r) => r.blocked);

  if (blocked) {
    process.stderr.write(blocked.reason ?? "Blocked by ai-hooks");
    process.exit(2);
  }
}

function resolvePreToolEvent(toolName, toolInput, cwd, timestamp, metadata) {
  if (isMcpTool(toolName)) {
    const { server, method } = parseMcpTool(toolName, toolInput);
    return {
      type: "mcp:before",
      server,
      method,
      params: toolInput.params ?? toolInput,
      timestamp,
      metadata,
    };
  }

  switch (toolName) {
    case "Create":
    case "Write":
      return {
        type: "file:write",
        path: toolInput.file_path ?? toolInput.path ?? "",
        content: toolInput.content ?? "",
        timestamp,
        metadata,
      };
    case "Edit":
    case "MultiEdit":
    case "ApplyPatch":
      return {
        type: "file:edit",
        path: toolInput.file_path ?? toolInput.path ?? "",
        oldContent: toolInput.old_string ?? toolInput.old_str ?? toolInput.oldContent ?? "",
        newContent:
          toolInput.new_string ?? toolInput.new_str ?? toolInput.newContent ?? toolInput.patch ?? "",
        timestamp,
        metadata,
      };
    case "Read":
      return {
        type: "file:read",
        path: toolInput.file_path ?? toolInput.path ?? "",
        timestamp,
        metadata,
      };
    case "Execute":
    case "Bash":
      return {
        type: "shell:before",
        command: toolInput.command ?? "",
        cwd: toolInput.cwd ?? cwd,
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

function resolvePostToolEvent(toolName, toolInput, toolResponse, cwd, timestamp, metadata) {
  if (isMcpTool(toolName)) {
    const { server, method } = parseMcpTool(toolName, toolInput);
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

  switch (toolName) {
    case "Execute":
    case "Bash":
      return {
        type: "shell:after",
        command: toolInput.command ?? "",
        cwd: toolInput.cwd ?? cwd,
        exitCode: toolResponse.exitCode ?? toolResponse.exit_code ?? 0,
        stdout: toolResponse.stdout ?? "",
        stderr: toolResponse.stderr ?? "",
        duration: 0,
        timestamp,
        metadata,
      };
    default:
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
}

run().catch((err) => {
  console.error("[ai-hooks] Error:", err.message);
  process.exit(1);
});
`;
  }
}

// Auto-register
const adapter = new DroidAdapter();
registry.register(adapter);

export { DroidAdapter };
export default adapter;
