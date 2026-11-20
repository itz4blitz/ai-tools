import { BaseAdapter, registry } from "./index.js";
import type {
  AdapterCapabilities,
  GeneratedConfig,
  HookDefinition,
  HookEventType,
} from "../types/index.js";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Event mapping: ai-hooks universal events -> Cline native hooks.
 *
 * Cline supports seven hook events (since v3.36):
 *   PreToolUse, PostToolUse, UserPromptSubmit,
 *   TaskStart, TaskResume, TaskCancel, PreCompact
 *
 * Hook scripts are executables in .clinerules/hooks/ (project) or
 * ~/Documents/Cline/Rules/Hooks/ (global). They receive JSON via STDIN
 * and return JSON via STDOUT. The `cancel` field in output blocks
 * PreToolUse and UserPromptSubmit actions, and `contextModification`
 * injects additional context back into the conversation.
 *
 * Reference: https://docs.cline.bot/features/hooks
 */
const EVENT_MAP: Record<string, string[]> = {
  "session:start": ["TaskStart"],
  "session:end": ["TaskCancel"],
  "prompt:submit": ["UserPromptSubmit"],
  "prompt:response": [],
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
  notification: [],
};

const REVERSE_MAP: Record<string, HookEventType[]> = {
  TaskStart: ["session:start"],
  TaskCancel: ["session:end"],
  TaskResume: ["session:start"],
  UserPromptSubmit: ["prompt:submit"],
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
  PreCompact: [],
};

const CLINE_HOOK_NAMES = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "TaskStart",
  "TaskResume",
  "TaskCancel",
  "PreCompact",
] as const;

export type ResolveClineGlobalStorageOptions = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Resolve VS Code's globalStorage directory for the Cline extension
 * (`saoudrizwan.claude-dev`) across macOS, Windows, and Linux.
 */
export function getClineGlobalStoragePath(options: ResolveClineGlobalStorageOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;

  if (platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Code",
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev",
    );
  }

  if (platform === "win32") {
    const appData = env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  }

  const xdgConfig = env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(xdgConfig, "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
}

/**
 * Cline adapter for ai-hooks.
 *
 * Generates executable hook scripts in `.clinerules/hooks/` that delegate
 * to the ai-hooks runtime. Cline hooks receive JSON via STDIN (v3.36+ schema
 * with `preToolUse`, `postToolUse`, `userPromptSubmit`, `taskStart`, etc.)
 * and return JSON via STDOUT with `cancel`, `errorMessage`, and optional
 * `contextModification`.
 *
 * Reference: https://docs.cline.bot/features/hooks
 */
class ClineAdapter extends BaseAdapter {
  readonly id = "cline";
  readonly name = "Cline";
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

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (existsSync(resolve(dir, ".clinerules"))) return true;
    if (existsSync(getClineGlobalStoragePath())) return true;
    if (existsSync(join(homedir(), ".cline"))) return true;
    return this.commandExists("cline");
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

    // Generate one executable script per needed hook event
    for (const event of neededEvents) {
      configs.push({
        path: `.clinerules/hooks/${event}`,
        content: this.generateHookScript(event),
        format: "js",
      });
    }

    return configs;
  }

  override async install(configs: GeneratedConfig[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const config of configs) {
      const fullPath = resolve(dir, config.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, config.content, "utf-8");

      if (process.platform === "win32") {
        const scriptName = basename(fullPath);
        const wrapperPath = `${fullPath}.ps1`;
        const wrapperContent = [
          "# Generated by ai-hooks for Cline on Windows",
          `$scriptPath = Join-Path $PSScriptRoot ${JSON.stringify(scriptName)}`,
          "& node $scriptPath",
          "exit $LASTEXITCODE",
          "",
        ].join("\n");
        await writeFile(wrapperPath, wrapperContent, "utf-8");
      } else {
        await chmod(fullPath, 0o755);
      }
    }
  }

  mapEvent(event: HookEventType): string[] {
    return EVENT_MAP[event] ?? [];
  }

  mapNativeEvent(nativeEvent: string): HookEventType[] {
    return REVERSE_MAP[nativeEvent] ?? [];
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const name of CLINE_HOOK_NAMES) {
      const relPath = `.clinerules/hooks/${name}`;
      if (cwd) {
        const fullPath = resolve(dir, relPath);
        if (existsSync(fullPath)) await rm(fullPath);
        const ps1Path = `${fullPath}.ps1`;
        if (existsSync(ps1Path)) await rm(ps1Path);
      } else {
        await this.removeFile(relPath);
        await this.removeFile(`${relPath}.ps1`);
      }
    }
  }

  private generateHookScript(eventName: string): string {
    return `#!/usr/bin/env node
/**
 * ai-hooks runner for Cline (${eventName}).
 * Generated by: ai-hooks generate
 *
 * Cline v3.36+ passes hook event data as JSON via STDIN with:
 *   hookName, taskId, workspaceRoots,
 *   preToolUse: { toolName, parameters },
 *   postToolUse: { toolName, parameters, result, success, executionTimeMs },
 *   userPromptSubmit: { prompt },
 *   taskStart: { taskMetadata }
 * (with backwards-compatible fallback for legacy pendingToolInfo / userMessage).
 *
 * Output JSON with { cancel: true, errorMessage: "..." } to block.
 * Output JSON with { cancel: false, contextModification?: "..." } to allow.
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

function parseMcpParams(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return { raw };
    }
  }
  return {};
}

async function run() {
  const raw = await readStdin();
  const input = JSON.parse(raw || "{}");
  const hookName = input.hookName ?? ${JSON.stringify(eventName)};

  const preTool = input.preToolUse ?? {};
  const postTool = input.postToolUse ?? {};
  const legacyTool = input.pendingToolInfo ?? {};

  const config = await loadConfig();
  const engine = new HookEngine(config);
  const toolInfo = { name: "cline", version: "1.0" };
  const timestamp = Date.now();
  const metadata = {
    taskId: input.taskId ?? "",
    ...(input.taskStart ? { taskStart: input.taskStart } : {}),
  };

  let event;
  switch (hookName) {
    case "TaskStart":
    case "TaskResume":
      event = {
        type: "session:start",
        tool: "cline",
        version: "1.0",
        workingDirectory: (input.workspaceRoots ?? [])[0] ?? process.cwd(),
        timestamp,
        metadata,
      };
      break;
    case "TaskCancel":
      event = { type: "session:end", tool: "cline", duration: 0, timestamp, metadata };
      break;
    case "UserPromptSubmit":
      event = {
        type: "prompt:submit",
        prompt: input.userPromptSubmit?.prompt ?? input.userMessage ?? "",
        timestamp,
        metadata,
      };
      break;
    case "PreToolUse": {
      const toolName = preTool.toolName ?? legacyTool.toolName ?? "";
      const params = preTool.parameters ?? legacyTool;
      event = resolvePreToolEvent(toolName, params, timestamp, metadata);
      break;
    }
    case "PostToolUse": {
      const toolName = postTool.toolName ?? legacyTool.toolName ?? "";
      const params = postTool.parameters ?? legacyTool;
      event = resolvePostToolEvent(toolName, params, postTool, timestamp, metadata);
      break;
    }
    default:
      process.stdout.write(JSON.stringify({ cancel: false }));
      process.exit(0);
  }

  const results = await engine.emit(event, toolInfo);
  const blocked = results.find((r) => r.blocked);
  const contextParts = results
    .map((r) => (typeof r.data?.additionalContext === "string" ? r.data.additionalContext : ""))
    .filter(Boolean);
  const contextModification = contextParts.length > 0 ? contextParts.join("\\n") : undefined;

  if (blocked) {
    process.stdout.write(JSON.stringify({
      cancel: true,
      errorMessage: blocked.reason ?? "Blocked by ai-hooks",
      ...(contextModification ? { contextModification } : {}),
    }));
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    cancel: false,
    ...(contextModification ? { contextModification } : {}),
  }));
}

function resolvePreToolEvent(toolName, params, timestamp, metadata) {
  switch (toolName) {
    case "write_to_file":
      return { type: "file:write", path: params.path ?? "", content: params.content ?? "", timestamp, metadata };
    case "replace_in_file":
      return { type: "file:edit", path: params.path ?? "", oldContent: params.diff ?? "", newContent: "", timestamp, metadata };
    case "read_file":
      return { type: "file:read", path: params.path ?? "", timestamp, metadata };
    case "execute_command":
      return { type: "shell:before", command: params.command ?? "", cwd: process.cwd(), timestamp, metadata };
    case "use_mcp_tool":
      return {
        type: "mcp:before",
        server: params.server_name ?? params.mcpServer ?? "",
        method: params.tool_name ?? params.mcpTool ?? "",
        params: parseMcpParams(params.arguments ?? params.input),
        timestamp,
        metadata,
      };
    default:
      return { type: "tool:before", toolName: toolName || "unknown", input: params, timestamp, metadata };
  }
}

function resolvePostToolEvent(toolName, params, postTool, timestamp, metadata) {
  const duration = typeof postTool.executionTimeMs === "number" ? postTool.executionTimeMs : 0;
  const output = postTool.result ?? {};
  switch (toolName) {
    case "execute_command":
      return {
        type: "shell:after",
        command: params.command ?? "",
        cwd: process.cwd(),
        exitCode: postTool.success === false ? 1 : 0,
        stdout: typeof postTool.result === "string" ? postTool.result : JSON.stringify(postTool.result ?? ""),
        stderr: "",
        duration,
        timestamp,
        metadata,
      };
    case "use_mcp_tool":
      return {
        type: "mcp:after",
        server: params.server_name ?? params.mcpServer ?? "",
        method: params.tool_name ?? params.mcpTool ?? "",
        params: parseMcpParams(params.arguments ?? params.input),
        result: output,
        duration,
        timestamp,
        metadata,
      };
    default:
      return { type: "tool:after", toolName: toolName || "unknown", input: params, output, duration, timestamp, metadata };
  }
}

run().catch((err) => {
  console.error("[ai-hooks] Error:", err.message);
  process.stdout.write(JSON.stringify({ cancel: false }));
  process.exit(0);
});
`;
  }
}

// Auto-register
const adapter = new ClineAdapter();
registry.register(adapter);

export { ClineAdapter };
export default adapter;
