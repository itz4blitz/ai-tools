import { BaseAdapter, registry } from "./index.js";
import type {
  AdapterCapabilities,
  GeneratedConfig,
  HookDefinition,
  HookEventType,
} from "../types/index.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Event mapping: ai-hooks universal events -> Cursor native hooks.
 *
 * Reference: https://docs.cursor.com/configuration/hooks
 */
const EVENT_MAP: Record<string, string[]> = {
  "session:start": ["sessionStart"],
  "session:end": ["sessionEnd"],
  "prompt:submit": ["beforeSubmitPrompt"],
  "prompt:response": ["afterAgentResponse"],
  "tool:before": ["preToolUse"],
  "tool:after": ["postToolUse"],
  "file:read": ["beforeReadFile"],
  "file:write": ["afterFileEdit"],
  "file:edit": ["afterFileEdit"],
  "file:delete": [],
  "shell:before": ["beforeShellExecution"],
  "shell:after": ["afterShellExecution"],
  "mcp:before": ["beforeMCPExecution"],
  "mcp:after": ["afterMCPExecution"],
};

const REVERSE_MAP: Record<string, HookEventType[]> = {
  sessionStart: ["session:start"],
  sessionEnd: ["session:end"],
  stop: ["session:end"],
  beforeSubmitPrompt: ["prompt:submit"],
  afterAgentResponse: ["prompt:response"],
  preToolUse: ["tool:before"],
  postToolUse: ["tool:after"],
  beforeReadFile: ["file:read"],
  afterFileEdit: ["file:write", "file:edit"],
  beforeShellExecution: ["shell:before"],
  afterShellExecution: ["shell:after"],
  beforeMCPExecution: ["mcp:before"],
  afterMCPExecution: ["mcp:after"],
};

const RUNNER_REL_PATH = ".cursor/hooks/ai-tools-hooks-runner.js";
const HOOKS_JSON_PATH = ".cursor/hooks.json";

type CursorHookEntry = {
  command?: string;
  [key: string]: unknown;
};

type CursorHooksFile = {
  version?: number;
  hooks?: Record<string, unknown[]>;
  [key: string]: unknown;
};

function isAiToolsHookEntry(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const cmd = (entry as CursorHookEntry).command;
  if (typeof cmd !== "string") return false;
  return cmd.includes("ai-tools-hooks-runner.js") || cmd.includes("ai-hooks-runner.js");
}

function quoteCommandPath(filePath: string): string {
  return `"${filePath.replace(/"/g, '\\"')}"`;
}

function parseHooksFile(raw: string): CursorHooksFile | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CursorHooksFile;
    }
    return null;
  } catch {
    return null;
  }
}

function mergeCursorHooks(
  existing: CursorHooksFile | null,
  generatedHooks: Record<string, unknown[]>,
): CursorHooksFile {
  const base: CursorHooksFile = existing ? { ...existing } : {};
  const existingHooks =
    base.hooks !== null &&
    base.hooks !== undefined &&
    typeof base.hooks === "object" &&
    !Array.isArray(base.hooks)
      ? base.hooks
      : {};

  const mergedHooks: Record<string, unknown[]> = {};

  // Preserve non-ai-tools entries from existing hooks
  for (const [event, entries] of Object.entries(existingHooks)) {
    if (!Array.isArray(entries)) continue;
    const preserved = entries.filter((entry) => !isAiToolsHookEntry(entry));
    if (preserved.length > 0) {
      mergedHooks[event] = preserved;
    }
  }

  // Append newly generated ai-tools entries
  for (const [event, entries] of Object.entries(generatedHooks)) {
    if (!mergedHooks[event]) {
      mergedHooks[event] = [];
    }
    mergedHooks[event].push(...entries);
  }

  return {
    ...base,
    version: typeof base.version === "number" ? base.version : 1,
    hooks: mergedHooks,
  };
}

/**
 * Cursor adapter for ai-hooks.
 *
 * Generates `.cursor/hooks.json` with hook entries and a runner script.
 * Cursor hooks use a `{ "version": 1, "hooks": { ... } }` format.
 *
 * For blocking hooks (`beforeReadFile`, `beforeShellExecution`, `beforeMCPExecution`, `preToolUse`),
 * the runner outputs `{ "permission": "deny", "user_message": "...", "agent_message": "..." }`
 * or `{ "permission": "allow" }`.
 * For `beforeSubmitPrompt`, the runner outputs `{ "continue": false, "user_message": "..." }`
 * or `{ "continue": true }`.
 *
 * Reference: https://docs.cursor.com/configuration/hooks
 */
class CursorAdapter extends BaseAdapter {
  readonly id = "cursor";
  readonly name = "Cursor";
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
    blockableEvents: ["prompt:submit", "tool:before", "file:read", "shell:before", "mcp:before"],
  };

  async detect(): Promise<boolean> {
    const hasCommand = await this.commandExists("cursor");
    const hasDir = existsSync(resolve(process.cwd(), ".cursor"));
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
      path: RUNNER_REL_PATH,
      content: this.generateRunner(),
      format: "js",
    });

    // Build Cursor hooks entries
    const runnerPath = resolve(process.cwd(), RUNNER_REL_PATH);
    const quotedRunnerPath = quoteCommandPath(runnerPath);
    const generatedHooks: Record<string, unknown[]> = {};

    for (const event of neededEvents) {
      generatedHooks[event] = [
        {
          command: `node ${quotedRunnerPath} ${event}`,
        },
      ];
    }

    // Merge into existing .cursor/hooks.json if present
    let existing: CursorHooksFile | null = null;
    const hooksJsonFullPath = resolve(process.cwd(), HOOKS_JSON_PATH);
    if (existsSync(hooksJsonFullPath)) {
      try {
        existing = parseHooksFile(await readFile(hooksJsonFullPath, "utf-8"));
      } catch {
        existing = null;
      }
    }

    const merged = mergeCursorHooks(existing, generatedHooks);

    configs.push({
      path: HOOKS_JSON_PATH,
      content: JSON.stringify(merged, null, 2) + "\n",
      format: "json",
    });

    return configs;
  }

  override async install(configs: GeneratedConfig[]): Promise<void> {
    for (const config of configs) {
      const fullPath = resolve(process.cwd(), config.path);
      await mkdir(dirname(fullPath), { recursive: true });

      if (config.path === HOOKS_JSON_PATH && existsSync(fullPath)) {
        try {
          const existing = parseHooksFile(await readFile(fullPath, "utf-8"));
          const incoming = parseHooksFile(config.content);
          if (existing && incoming) {
            const incomingHooks =
              incoming.hooks !== null &&
              incoming.hooks !== undefined &&
              typeof incoming.hooks === "object" &&
              !Array.isArray(incoming.hooks)
                ? incoming.hooks
                : {};
            // Extract only ai-tools entries from incoming to avoid duplicating preserved user entries
            const aiToolsOnly: Record<string, unknown[]> = {};
            for (const [event, entries] of Object.entries(incomingHooks)) {
              if (!Array.isArray(entries)) continue;
              const aiEntries = entries.filter((entry) => isAiToolsHookEntry(entry));
              if (aiEntries.length > 0) {
                aiToolsOnly[event] = aiEntries;
              }
            }
            const merged = mergeCursorHooks(existing, aiToolsOnly);
            await writeFile(fullPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
            continue;
          }
        } catch {
          // Fall through to default write if existing file is unreadable
        }
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

  async uninstall(): Promise<void> {
    await this.removeFile(".cursor/hooks/ai-hooks-runner.js");
    await this.removeFile(RUNNER_REL_PATH);

    const hooksJsonFullPath = resolve(process.cwd(), HOOKS_JSON_PATH);
    if (!existsSync(hooksJsonFullPath)) return;

    try {
      const existing = parseHooksFile(await readFile(hooksJsonFullPath, "utf-8"));
      if (!existing) {
        return;
      }

      const existingHooks =
        existing.hooks !== null &&
        existing.hooks !== undefined &&
        typeof existing.hooks === "object" &&
        !Array.isArray(existing.hooks)
          ? existing.hooks
          : {};

      const remainingHooks: Record<string, unknown[]> = {};
      for (const [event, entries] of Object.entries(existingHooks)) {
        if (!Array.isArray(entries)) continue;
        const preserved = entries.filter((entry) => !isAiToolsHookEntry(entry));
        if (preserved.length > 0) {
          remainingHooks[event] = preserved;
        }
      }

      const extraTopLevelKeys = Object.keys(existing).filter(
        (k) => k !== "version" && k !== "hooks",
      );

      if (Object.keys(remainingHooks).length === 0 && extraTopLevelKeys.length === 0) {
        await this.removeFile(HOOKS_JSON_PATH);
      } else {
        const updated: CursorHooksFile = {
          ...existing,
          hooks: remainingHooks,
        };
        await writeFile(hooksJsonFullPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
      }
    } catch {
      // Leave user file intact if unreadable
    }
  }

  private generateRunner(): string {
    return `#!/usr/bin/env node
/**
 * ai-hooks runner for Cursor.
 * Generated by: ai-hooks generate
 *
 * Cursor passes the hook event name as a CLI argument and event payload on STDIN.
 * Permission hooks (beforeReadFile, beforeShellExecution, beforeMCPExecution, preToolUse)
 * return JSON: { "permission": "deny", "user_message": "...", "agent_message": "..." }
 * or { "permission": "allow" }.
 * Prompt hooks (beforeSubmitPrompt) return JSON: { "continue": false, "user_message": "..." }
 * or { "continue": true }.
 *
 * DO NOT EDIT - regenerate with: ai-hooks generate
 */
import { loadConfig, HookEngine } from "@itz4blitz/ai-tools-hooks";

const PROJECT_ROOT = ${JSON.stringify(resolve(process.cwd()))};
process.chdir(PROJECT_ROOT);

const PERMISSION_EVENTS = new Set([
  "beforeReadFile",
  "beforeShellExecution",
  "beforeMCPExecution",
  "preToolUse",
]);

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return { raw: value };
    }
  }
  return {};
}

function parseMaybeJson(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value ?? null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function run() {
  const hookEventName = process.argv[2] ?? "";
  let input = {};
  try {
    const raw = await readStdin();
    input = JSON.parse(raw || "{}");
  } catch {
    input = {};
  }

  const config = await loadConfig();
  const engine = new HookEngine(config);
  const toolInfo = { name: "cursor", version: "1.0" };
  const timestamp = Date.now();
  const metadata = {};

  let event;
  switch (hookEventName) {
    case "sessionStart":
      event = {
        type: "session:start",
        tool: "cursor",
        version: "1.0",
        workingDirectory: input.cwd ?? (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined) ?? process.cwd(),
        timestamp,
        metadata,
      };
      break;
    case "sessionEnd":
    case "stop":
      event = {
        type: "session:end",
        tool: "cursor",
        duration: input.duration_ms ?? input.duration ?? 0,
        timestamp,
        metadata,
      };
      break;
    case "beforeSubmitPrompt":
      event = { type: "prompt:submit", prompt: input.prompt ?? "", timestamp, metadata };
      break;
    case "afterAgentResponse":
      event = {
        type: "prompt:response",
        response: input.text ?? input.response ?? "",
        model: input.model ?? "",
        tokens: { input: 0, output: 0 },
        timestamp,
        metadata,
      };
      break;
    case "preToolUse":
      event = {
        type: "tool:before",
        toolName: input.tool_name ?? input.toolName ?? "",
        input: parseObject(input.tool_input ?? input.arguments ?? input.input),
        timestamp,
        metadata,
      };
      break;
    case "postToolUse":
      event = {
        type: "tool:after",
        toolName: input.tool_name ?? input.toolName ?? "",
        input: parseObject(input.tool_input ?? input.arguments ?? input.input),
        output: parseMaybeJson(input.tool_output ?? input.output),
        duration: input.duration_ms ?? input.duration ?? 0,
        timestamp,
        metadata,
      };
      break;
    case "beforeShellExecution":
      event = {
        type: "shell:before",
        command: input.command ?? "",
        cwd: input.cwd ?? process.cwd(),
        timestamp,
        metadata,
      };
      break;
    case "afterShellExecution":
      event = {
        type: "shell:after",
        command: input.command ?? "",
        cwd: input.cwd ?? process.cwd(),
        exitCode: input.exit_code ?? input.exitCode ?? 0,
        stdout: input.output ?? input.stdout ?? "",
        stderr: input.stderr ?? "",
        duration: input.duration_ms ?? input.duration ?? 0,
        timestamp,
        metadata,
      };
      break;
    case "beforeMCPExecution":
      event = {
        type: "mcp:before",
        server: input.server_name ?? input.server ?? "",
        method: input.tool_name ?? input.method ?? "",
        params: parseObject(input.tool_input ?? input.arguments ?? input.params),
        timestamp,
        metadata,
      };
      break;
    case "afterMCPExecution":
      event = {
        type: "mcp:after",
        server: input.server_name ?? input.server ?? "",
        method: input.tool_name ?? input.method ?? "",
        params: parseObject(input.tool_input ?? input.arguments ?? input.params),
        result: parseMaybeJson(input.result_json ?? input.result),
        duration: input.duration_ms ?? input.duration ?? 0,
        timestamp,
        metadata,
      };
      break;
    case "beforeReadFile":
      event = {
        type: "file:read",
        path: input.file_path ?? input.path ?? "",
        timestamp,
        metadata,
      };
      break;
    case "afterFileEdit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const oldContent = edits.map((e) => e?.old_string ?? "").join("\\n");
      const newContent = edits.map((e) => e?.new_string ?? "").join("\\n");
      if (edits.length > 0) {
        metadata.edits = edits;
      }
      event = {
        type: "file:edit",
        path: input.file_path ?? input.path ?? "",
        oldContent,
        newContent,
        timestamp,
        metadata,
      };
      break;
    }
    default:
      process.exit(0);
  }

  const results = await engine.emit(event, toolInfo);
  const blocked = results.find((r) => r.blocked);

  if (hookEventName === "beforeSubmitPrompt") {
    if (blocked) {
      const reason = blocked.reason ?? "Blocked by ai-hooks";
      process.stdout.write(JSON.stringify({
        continue: false,
        user_message: reason,
        agent_message: reason,
      }));
    } else {
      process.stdout.write(JSON.stringify({ continue: true }));
    }
    process.exit(0);
  }

  if (blocked && hookEventName === "stop") {
    process.stdout.write(JSON.stringify({
      followup_message: blocked.reason ?? "Blocked by ai-hooks",
    }));
    process.exit(0);
  }

  if (blocked) {
    const reason = blocked.reason ?? "Blocked by ai-hooks";
    process.stdout.write(JSON.stringify({
      permission: "deny",
      user_message: reason,
      agent_message: reason,
    }));
    process.exit(0);
  }

  if (PERMISSION_EVENTS.has(hookEventName)) {
    process.stdout.write(JSON.stringify({ permission: "allow" }));
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
const adapter = new CursorAdapter();
registry.register(adapter);

export { CursorAdapter };
export default adapter;
