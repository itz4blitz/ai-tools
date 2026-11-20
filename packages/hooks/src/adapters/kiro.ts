import { BaseAdapter, registry } from "./index.js";
import type {
  AdapterCapabilities,
  GeneratedConfig,
  HookDefinition,
  HookEventType,
} from "../types/index.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Event mapping: ai-hooks universal events -> Kiro CLI native hooks.
 *
 * Kiro supports five hook types:
 *   agentSpawn, userPromptSubmit, preToolUse, postToolUse, stop
 *
 * Reference: https://kiro.dev/docs/cli/hooks/
 */
const EVENT_MAP: Record<string, string[]> = {
  "session:start": ["agentSpawn"],
  "session:end": ["stop"],
  "prompt:submit": ["userPromptSubmit"],
  "prompt:response": ["stop"],
  "tool:before": ["preToolUse"],
  "tool:after": ["postToolUse"],
  "file:read": ["preToolUse"],
  "file:write": ["preToolUse"],
  "file:edit": ["preToolUse"],
  "file:delete": ["preToolUse"],
  "shell:before": ["preToolUse"],
  "shell:after": ["postToolUse"],
  "mcp:before": ["preToolUse"],
  "mcp:after": ["postToolUse"],
};

const REVERSE_MAP: Record<string, HookEventType[]> = {
  agentSpawn: ["session:start"],
  AgentSpawn: ["session:start"],
  userPromptSubmit: ["prompt:submit"],
  UserPromptSubmit: ["prompt:submit"],
  preToolUse: [
    "tool:before",
    "file:read",
    "file:write",
    "file:edit",
    "file:delete",
    "shell:before",
    "mcp:before",
  ],
  PreToolUse: [
    "tool:before",
    "file:read",
    "file:write",
    "file:edit",
    "file:delete",
    "shell:before",
    "mcp:before",
  ],
  postToolUse: ["tool:after", "shell:after", "mcp:after"],
  PostToolUse: ["tool:after", "shell:after", "mcp:after"],
  stop: ["session:end", "prompt:response"],
  Stop: ["session:end", "prompt:response"],
};

type KiroV1HookEntry = {
  name: string;
  trigger: string;
  matcher?: string;
  action: {
    type: "command";
    command: string;
  };
  enabled: true;
};

/**
 * Kiro CLI adapter for ai-hooks.
 *
 * Generates standalone Kiro v1 hook configs at `.kiro/hooks/ai-tools-hooks.json`
 * and a Node runner script at `.kiro/hooks/ai-tools-hooks-runner.js`.
 *
 * Hook scripts receive event data as JSON via STDIN. Exit code 2 blocks
 * execution on blockable hooks.
 *
 * Reference: https://kiro.dev/docs/cli/hooks/
 */
class KiroAdapter extends BaseAdapter {
  readonly id = "kiro";
  readonly name = "Kiro CLI";
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
    const hasCommand = (await this.commandExists("kiro")) || (await this.commandExists("kiro-cli"));
    const hasDir = existsSync(resolve(process.cwd(), ".kiro"));
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

    const runnerRelPath = ".kiro/hooks/ai-tools-hooks-runner.js";
    const runnerAbsPath = resolve(process.cwd(), runnerRelPath);
    const quotedRunnerPath = runnerAbsPath.replace(/"/g, '\\"');

    // Generate the runner script
    configs.push({
      path: runnerRelPath,
      content: this.generateRunner(),
      format: "js",
    });

    // Build standalone Kiro v1 hook entries
    const hooksEntries: KiroV1HookEntry[] = [];

    for (const event of neededEvents) {
      const entry: KiroV1HookEntry = {
        name: `ai-tools-${event}`,
        trigger: event,
        action: {
          type: "command",
          command: `node "${quotedRunnerPath}"`,
        },
        enabled: true,
      };

      // preToolUse and postToolUse support matchers; use wildcard
      if (event === "preToolUse" || event === "postToolUse") {
        entry.matcher = "*";
      }

      hooksEntries.push(entry);
    }

    configs.push({
      path: ".kiro/hooks/ai-tools-hooks.json",
      content: `${JSON.stringify({ version: "v1", hooks: hooksEntries }, null, 2)}\n`,
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

  async uninstall(): Promise<void> {
    await this.removeFile(".kiro/hooks/ai-hooks-runner.js");
    await this.removeFile(".kiro/hooks/ai-hooks.json");
    await this.removeFile(".kiro/hooks/ai-tools-hooks-runner.js");
    await this.removeFile(".kiro/hooks/ai-tools-hooks.json");
  }

  private generateRunner(): string {
    return `#!/usr/bin/env node
/**
 * ai-hooks runner for Kiro CLI.
 * Generated by: ai-hooks generate
 *
 * Kiro passes hook event data as JSON via STDIN.
 * Exit code 0 = success, exit code 2 = block.
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

function parseMcpToolName(toolName) {
  if (!toolName || typeof toolName !== "string") return null;
  if (toolName.startsWith("@")) {
    const slash = toolName.indexOf("/");
    if (slash > 1 && slash < toolName.length - 1) {
      return { server: toolName.slice(1, slash), method: toolName.slice(slash + 1) };
    }
  }
  if (toolName.startsWith("mcp__")) {
    const rest = toolName.slice(5);
    const sep = rest.indexOf("__");
    if (sep > 0 && sep < rest.length - 2) {
      return { server: rest.slice(0, sep), method: rest.slice(sep + 2) };
    }
  }
  const triple = toolName.indexOf("___");
  if (triple > 0 && triple < toolName.length - 3) {
    return { server: toolName.slice(0, triple), method: toolName.slice(triple + 3) };
  }
  return null;
}

async function run() {
  const raw = await readStdin();
  const input = JSON.parse(raw || "{}");
  const hookEventName = input.hook_event_name ?? "";
  const toolName = input.tool_name ?? "";
  const toolInput = input.tool_input ?? {};

  const config = await loadConfig();
  const engine = new HookEngine(config);
  const toolInfo = { name: "kiro", version: "1.0" };
  const timestamp = Date.now();
  const metadata = {};

  const events = [];
  switch (hookEventName) {
    case "agentSpawn":
    case "AgentSpawn":
      events.push({
        type: "session:start",
        tool: "kiro",
        version: "1.0",
        workingDirectory: input.cwd ?? process.cwd(),
        timestamp,
        metadata,
      });
      break;
    case "userPromptSubmit":
    case "UserPromptSubmit":
      events.push({
        type: "prompt:submit",
        prompt: input.prompt ?? toolInput.prompt ?? "",
        timestamp,
        metadata,
      });
      break;
    case "preToolUse":
    case "PreToolUse":
      events.push(resolvePreToolEvent(toolName, toolInput, timestamp, metadata));
      break;
    case "postToolUse":
    case "PostToolUse":
      events.push(
        resolvePostToolEvent(toolName, toolInput, input.tool_response ?? {}, timestamp, metadata),
      );
      break;
    case "stop":
    case "Stop":
      events.push({
        type: "prompt:response",
        response: input.response ?? input.last_assistant_message ?? "",
        model: input.model ?? "unknown",
        tokens: {
          input: input.tokens?.input ?? 0,
          output: input.tokens?.output ?? 0,
        },
        timestamp,
        metadata,
      });
      events.push({
        type: "session:end",
        tool: "kiro",
        duration: input.duration ?? 0,
        timestamp,
        metadata,
      });
      break;
    default:
      process.exit(0);
  }

  for (const event of events) {
    const results = await engine.emit(event, toolInfo);
    const blocked = results.find((r) => r.blocked);
    if (blocked) {
      process.stderr.write(blocked.reason ?? "Blocked by ai-hooks");
      process.exit(2);
    }
  }
}

function resolvePreToolEvent(toolName, toolInput, timestamp, metadata) {
  const mcp = parseMcpToolName(toolName);
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
    case "fs_write":
    case "write":
      return { type: "file:write", path: toolInput.path ?? "", content: toolInput.content ?? "", timestamp, metadata };
    case "fs_edit":
    case "edit":
      return { type: "file:edit", path: toolInput.path ?? "", oldContent: toolInput.old_string ?? "", newContent: toolInput.new_string ?? "", timestamp, metadata };
    case "fs_read":
    case "read":
      return { type: "file:read", path: toolInput.path ?? "", timestamp, metadata };
    case "fs_delete":
    case "delete":
    case "delete_file":
    case "remove_file":
      return { type: "file:delete", path: toolInput.path ?? toolInput.file_path ?? "", timestamp, metadata };
    case "execute_bash":
    case "shell":
      return { type: "shell:before", command: toolInput.command ?? "", cwd: process.cwd(), timestamp, metadata };
    default:
      return { type: "tool:before", toolName: toolName || "unknown", input: toolInput, timestamp, metadata };
  }
}

function resolvePostToolEvent(toolName, toolInput, toolResponse, timestamp, metadata) {
  const mcp = parseMcpToolName(toolName);
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
    case "execute_bash":
    case "shell":
      return {
        type: "shell:after",
        command: toolInput.command ?? "",
        cwd: process.cwd(),
        exitCode: toolResponse.exitCode ?? 0,
        stdout: toolResponse.stdout ?? "",
        stderr: toolResponse.stderr ?? "",
        duration: 0,
        timestamp,
        metadata,
      };
    default:
      return { type: "tool:after", toolName: toolName || "unknown", input: toolInput, output: toolResponse, duration: 0, timestamp, metadata };
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
const adapter = new KiroAdapter();
registry.register(adapter);

export { KiroAdapter };
export default adapter;
