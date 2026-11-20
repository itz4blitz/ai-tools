import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { registry, BaseAdapter } from "./index.js";
import type {
  AdapterCapabilities,
  GeneratedConfig,
  HookDefinition,
  HookEventType,
} from "../types/index.js";

/**
 * Event mapping: ai-hooks universal events -> Codex native hooks.
 *
 * Codex supports lifecycle hooks through `.codex/hooks.json` with events like:
 *   SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Stop
 *
 * Reference: https://developers.openai.com/codex/hooks
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
  "shell:before": ["PreToolUse"],
  "shell:after": ["PostToolUse"],
  "mcp:before": ["PreToolUse"],
  "mcp:after": ["PostToolUse"],
};

const REVERSE_MAP: Record<string, HookEventType[]> = {
  SessionStart: ["session:start"],
  SessionEnd: ["session:end"],
  UserPromptSubmit: ["prompt:submit"],
  PreToolUse: ["tool:before", "file:read", "file:write", "file:edit", "shell:before", "mcp:before"],
  PostToolUse: ["tool:after", "shell:after", "mcp:after"],
  Stop: ["prompt:response"],
};

const HOOKS_JSON_PATH = ".codex/hooks.json";
const RUNNER_PATH = ".codex/hooks/ai-tools-hooks-runner.js";
const LEGACY_RUNNER_PATH = ".codex/hooks/ai-hooks-runner.js";

type CodexHookCommand = {
  type?: string;
  command?: string;
  timeout?: number;
  statusMessage?: string;
};

type CodexHookMatcherEntry = {
  matcher?: string;
  hooks?: CodexHookCommand[];
  [key: string]: unknown;
};

type CodexHooksConfigFile = {
  hooks?: Record<string, CodexHookMatcherEntry[]>;
  [key: string]: unknown;
};

function isAiToolsHookCommand(hook: CodexHookCommand): boolean {
  if (typeof hook.statusMessage === "string" && hook.statusMessage.startsWith("ai-hooks ")) {
    return true;
  }
  if (
    typeof hook.command === "string" &&
    (hook.command.includes("ai-tools-hooks-runner.js") ||
      hook.command.includes("ai-hooks-runner.js"))
  ) {
    return true;
  }
  return false;
}

function stripAiToolsEntries(entries: CodexHookMatcherEntry[]): CodexHookMatcherEntry[] {
  const kept: CodexHookMatcherEntry[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const remainingHooks = entry.hooks.filter((hook) => !isAiToolsHookCommand(hook));
    if (remainingHooks.length > 0) {
      kept.push({ ...entry, hooks: remainingHooks });
    }
  }
  return kept;
}

class CodexAdapter extends BaseAdapter {
  readonly id = "codex";
  readonly name = "Codex";
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
      "shell:before",
      "shell:after",
      "mcp:before",
      "mcp:after",
    ],
    blockableEvents: [
      "prompt:submit",
      "tool:before",
      "file:read",
      "file:write",
      "file:edit",
      "shell:before",
      "mcp:before",
    ],
  };

  async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    const hasDir = existsSync(resolve(dir, ".codex"));
    if (hasDir) return true;
    return this.commandExists("codex");
  }

  async generate(hooks: HookDefinition[]): Promise<GeneratedConfig[]> {
    const configs: GeneratedConfig[] = [];

    const neededEvents = new Set<string>();
    for (const hook of hooks) {
      for (const event of hook.events) {
        const nativeEvents = this.mapEvent(event);
        for (const nativeEvent of nativeEvents) {
          neededEvents.add(nativeEvent);
        }
      }
    }

    configs.push({
      path: RUNNER_PATH,
      content: this.generateRunner(),
      format: "js",
    });

    const runnerFullPath = resolve(process.cwd(), RUNNER_PATH);
    const hooksConfig: Record<string, CodexHookMatcherEntry[]> = {};
    for (const event of neededEvents) {
      if (!hooksConfig[event]) {
        hooksConfig[event] = [];
      }
      hooksConfig[event].push({
        hooks: [
          {
            type: "command",
            command: `node "${runnerFullPath}" ${event}`,
            timeout: 10,
            statusMessage: `ai-hooks ${event}`,
          },
        ],
      });
    }

    configs.push({
      path: HOOKS_JSON_PATH,
      content: JSON.stringify({ hooks: hooksConfig }, null, 2) + "\n",
      format: "json",
    });

    return configs;
  }

  override async install(configs: GeneratedConfig[]): Promise<void> {
    for (const config of configs) {
      const fullPath = resolve(process.cwd(), config.path);
      await mkdir(dirname(fullPath), { recursive: true });

      if (config.path === HOOKS_JSON_PATH && existsSync(fullPath)) {
        const merged = await this.mergeHooksConfig(fullPath, config.content);
        await writeFile(fullPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
        continue;
      }

      await writeFile(fullPath, config.content, "utf-8");
    }
  }

  mapEvent(event: HookEventType): string[] {
    return EVENT_MAP[event] ?? [];
  }

  mapNativeEvent(nativeEvent: string): HookEventType[] {
    return REVERSE_MAP[nativeEvent] ?? [];
  }

  override async uninstall(): Promise<void> {
    await this.removeFile(LEGACY_RUNNER_PATH);
    await this.removeFile(RUNNER_PATH);

    const hooksFullPath = resolve(process.cwd(), HOOKS_JSON_PATH);
    if (!existsSync(hooksFullPath)) return;

    let existing: CodexHooksConfigFile;
    try {
      existing = JSON.parse(await readFile(hooksFullPath, "utf-8")) as CodexHooksConfigFile;
    } catch {
      return;
    }

    if (!existing || typeof existing !== "object" || !existing.hooks) {
      return;
    }

    const nextHooks: Record<string, CodexHookMatcherEntry[]> = {};
    for (const [event, entries] of Object.entries(existing.hooks)) {
      if (!Array.isArray(entries)) continue;
      const remaining = stripAiToolsEntries(entries);
      if (remaining.length > 0) {
        nextHooks[event] = remaining;
      }
    }

    const { hooks: _removedHooks, ...otherKeys } = existing;
    if (Object.keys(nextHooks).length === 0 && Object.keys(otherKeys).length === 0) {
      await this.removeFile(HOOKS_JSON_PATH);
      return;
    }

    const updated: CodexHooksConfigFile =
      Object.keys(nextHooks).length > 0 ? { ...otherKeys, hooks: nextHooks } : { ...otherKeys };
    await writeFile(hooksFullPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
  }

  private async mergeHooksConfig(
    fullPath: string,
    incomingContent: string,
  ): Promise<CodexHooksConfigFile> {
    let existing: CodexHooksConfigFile = {};
    try {
      const parsed = JSON.parse(await readFile(fullPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as CodexHooksConfigFile;
      }
    } catch {
      existing = {};
    }

    const incoming = JSON.parse(incomingContent) as CodexHooksConfigFile;
    const existingHooks =
      existing.hooks && typeof existing.hooks === "object" ? existing.hooks : {};
    const incomingHooks =
      incoming.hooks && typeof incoming.hooks === "object" ? incoming.hooks : {};

    const mergedHooks: Record<string, CodexHookMatcherEntry[]> = {};

    for (const [event, entries] of Object.entries(existingHooks)) {
      if (!Array.isArray(entries)) continue;
      const remaining = stripAiToolsEntries(entries);
      if (remaining.length > 0) {
        mergedHooks[event] = remaining;
      }
    }

    for (const [event, entries] of Object.entries(incomingHooks)) {
      if (!Array.isArray(entries)) continue;
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
 * ai-hooks runner for Codex.
 * Generated by: ai-hooks generate
 *
 * Codex passes hook event data as JSON via STDIN. PreToolUse and
 * UserPromptSubmit can block execution via exit code 2 + stderr.
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

function getMcpIdentity(toolName) {
  if (!toolName.startsWith("mcp__")) {
    return null;
  }
  const parts = toolName.split("__");
  return {
    server: parts[1] ?? "unknown",
    method: toolName,
  };
}

function extractCommand(toolInput) {
  const raw = toolInput.command ?? toolInput.cmd ?? "";
  return Array.isArray(raw) ? raw.join(" ") : String(raw);
}

function resolvePreToolUse(toolName, toolInput, timestamp, metadata) {
  const mcp = getMcpIdentity(toolName);
  if (mcp) {
    return {
      type: "mcp:before",
      server: mcp.server,
      method: mcp.method,
      params: toolInput,
      timestamp,
      metadata,
    };
  }

  switch (toolName) {
    case "Bash":
    case "shell":
    case "exec_command":
    case "shell_command":
    case "local_shell":
      return {
        type: "shell:before",
        command: extractCommand(toolInput),
        cwd: toolInput.cwd ?? toolInput.workdir ?? process.cwd(),
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
    case "Write":
      return {
        type: "file:write",
        path: toolInput.file_path ?? toolInput.path ?? "",
        content: toolInput.content ?? "",
        timestamp,
        metadata,
      };
    case "Edit":
    case "apply_patch":
      return {
        type: "file:edit",
        path: toolInput.file_path ?? toolInput.path ?? "",
        oldContent: toolInput.old_string ?? toolInput.oldContent ?? toolInput.old ?? "",
        newContent: toolInput.new_string ?? toolInput.newContent ?? toolInput.new ?? toolInput.command ?? "",
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

function resolvePostToolUse(toolName, toolInput, toolResponse, timestamp, metadata) {
  const mcp = getMcpIdentity(toolName);
  if (mcp) {
    return {
      type: "mcp:after",
      server: mcp.server,
      method: mcp.method,
      params: toolInput,
      result: toolResponse,
      duration: 0,
      timestamp,
      metadata,
    };
  }

  switch (toolName) {
    case "Bash":
    case "shell":
    case "exec_command":
    case "shell_command":
    case "local_shell":
      return {
        type: "shell:after",
        command: extractCommand(toolInput),
        cwd: toolInput.cwd ?? toolInput.workdir ?? process.cwd(),
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

function buildEvents(hookEventName, input, timestamp, metadata) {
  switch (hookEventName) {
    case "SessionStart":
      return [
        {
          type: "session:start",
          tool: "codex",
          version: "1.0",
          workingDirectory: input.cwd ?? process.cwd(),
          timestamp,
          metadata,
        },
      ];
    case "SessionEnd":
      return [
        {
          type: "session:end",
          tool: "codex",
          duration: 0,
          timestamp,
          metadata,
        },
      ];
    case "UserPromptSubmit":
      return [
        {
          type: "prompt:submit",
          prompt: input.prompt ?? "",
          timestamp,
          metadata,
        },
      ];
    case "PreToolUse":
      return [resolvePreToolUse(input.tool_name ?? "", input.tool_input ?? {}, timestamp, metadata)];
    case "PostToolUse":
      return [
        resolvePostToolUse(
          input.tool_name ?? "",
          input.tool_input ?? {},
          input.tool_response ?? {},
          timestamp,
          metadata,
        ),
      ];
    case "Stop":
      if (typeof input.last_assistant_message === "string" && input.last_assistant_message.length > 0) {
        return [
          {
            type: "prompt:response",
            response: input.last_assistant_message,
            model: input.model ?? "codex",
            tokens: { input: 0, output: 0 },
            timestamp,
            metadata,
          },
        ];
      }
      return [];
    default:
      return [];
  }
}

async function run() {
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw || "{}");
  } catch {
    input = {};
  }

  const hookEventName = process.argv[2] ?? "";
  const config = await loadConfig();
  const engine = new HookEngine(config);
  const toolInfo = { name: "codex", version: "1.0" };
  const timestamp = Date.now();
  const metadata = {};

  const events = buildEvents(hookEventName, input, timestamp, metadata);
  if (!events.length) {
    process.exit(0);
  }

  const results = [];
  for (const event of events) {
    const emitted = await engine.emit(event, toolInfo);
    results.push(...emitted);
  }

  const blocked = results.find((result) => result.blocked);
  if (blocked && (hookEventName === "PreToolUse" || hookEventName === "UserPromptSubmit" || hookEventName === "Stop")) {
    process.stderr.write(blocked.reason ?? "Blocked by ai-hooks");
    process.exit(2);
  }
}

run().catch((err) => {
  console.error("[ai-hooks] Error:", err.message);
  process.exit(1);
});
`;
  }
}

const adapter = new CodexAdapter();
registry.register(adapter);

export { CodexAdapter };
export default adapter;
