import { BaseAdapter, registry } from "./index.js";
import type {
  AdapterCapabilities,
  GeneratedConfig,
  HookDefinition,
  HookEventType,
} from "../types/index.js";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Event mapping: ai-hooks universal events -> OpenCode plugin hooks.
 *
 * OpenCode (by SST) uses a plugin system (`@opencode-ai/plugin`) with
 * bus lifecycle events routed through `event: async ({ event }) => ...`
 * and top-level tool hooks `"tool.execute.before"` / `"tool.execute.after"`.
 *
 * Reference: https://opencode.ai/docs/plugins/
 */
const EVENT_MAP: Record<string, string[]> = {
  "session:start": ["session.created"],
  "session:end": ["session.idle"],
  "prompt:submit": ["message.updated"],
  "prompt:response": ["message.part.updated"],
  "tool:before": ["tool.execute.before"],
  "tool:after": ["tool.execute.after"],
  "file:read": ["tool.execute.before"],
  "file:write": ["tool.execute.before", "file.edited"],
  "file:edit": ["tool.execute.before", "file.edited"],
  "file:delete": ["tool.execute.before"],
  "shell:before": ["tool.execute.before"],
  "shell:after": ["tool.execute.after"],
  "mcp:before": ["tool.execute.before"],
  "mcp:after": ["tool.execute.after"],
  notification: ["tui.toast.show"],
};

const REVERSE_MAP: Record<string, HookEventType[]> = {
  "session.created": ["session:start"],
  "session.idle": ["session:end"],
  "message.updated": ["prompt:submit"],
  "message.part.updated": ["prompt:response"],
  "tool.execute.before": [
    "tool:before",
    "file:read",
    "file:write",
    "file:edit",
    "file:delete",
    "shell:before",
    "mcp:before",
  ],
  "tool.execute.after": ["tool:after", "shell:after", "mcp:after"],
  "file.edited": ["file:write", "file:edit"],
  "tui.toast.show": ["notification"],
};

const BUS_EVENTS = new Set([
  "session.created",
  "session.idle",
  "file.edited",
  "message.updated",
  "message.part.updated",
  "tui.toast.show",
]);

const HOOKS_PACKAGE_NAME = "@itz4blitz/ai-tools-hooks";
const PLUGIN_PATH = ".opencode/plugins/ai-tools-hooks-plugin.js";
const OPENCODE_PACKAGE_PATH = ".opencode/package.json";

/**
 * OpenCode adapter for ai-hooks.
 *
 * Generates an OpenCode plugin in `.opencode/plugins/` that hooks into
 * `tool.execute.before` / `tool.execute.after` and bus lifecycle events via
 * `event: async ({ event }) => ...`. Tool execution is blocked by throwing
 * an `Error` from `tool.execute.before`.
 *
 * Reference: https://opencode.ai/docs/plugins/
 */
class OpenCodeAdapter extends BaseAdapter {
  readonly id = "opencode";
  readonly name = "OpenCode";
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
    if (
      existsSync(resolve(dir, ".opencode")) ||
      existsSync(resolve(dir, "opencode.json")) ||
      existsSync(resolve(dir, "opencode.jsonc"))
    ) {
      return true;
    }
    return this.commandExists("opencode");
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

    // Generate the OpenCode plugin
    configs.push({
      path: PLUGIN_PATH,
      content: this.generatePlugin(neededEvents),
      format: "js",
    });

    // OpenCode reads plugin dependencies from .opencode/package.json
    configs.push({
      path: OPENCODE_PACKAGE_PATH,
      content:
        JSON.stringify(
          {
            type: "module",
            dependencies: {
              [HOOKS_PACKAGE_NAME]: "*",
            },
          },
          null,
          2,
        ) + "\n",
      format: "json",
    });

    return configs;
  }

  override async install(configs: GeneratedConfig[], cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    for (const config of configs) {
      const fullPath = resolve(dir, config.path);
      await mkdir(dirname(fullPath), { recursive: true });

      if (config.path === OPENCODE_PACKAGE_PATH && existsSync(fullPath)) {
        const existing = JSON.parse(await readFile(fullPath, "utf-8")) as {
          type?: string;
          dependencies?: Record<string, string>;
          [key: string]: unknown;
        };
        const generated = JSON.parse(config.content) as {
          type?: string;
          dependencies?: Record<string, string>;
        };
        const merged = {
          ...existing,
          type: existing.type ?? generated.type ?? "module",
          dependencies: {
            ...existing.dependencies,
            ...generated.dependencies,
          },
        };
        await writeFile(fullPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
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

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const legacyFiles = [
      ".opencode/plugins/ai-hooks-plugin.js",
      PLUGIN_PATH,
      ".opencode/plugins/package.json",
    ];

    for (const file of legacyFiles) {
      const fullPath = resolve(dir, file);
      if (existsSync(fullPath)) {
        await rm(fullPath);
      }
    }

    const pkgPath = resolve(dir, OPENCODE_PACKAGE_PATH);
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(await readFile(pkgPath, "utf-8")) as {
          type?: string;
          dependencies?: Record<string, string>;
          [key: string]: unknown;
        };
        if (pkg.dependencies && HOOKS_PACKAGE_NAME in pkg.dependencies) {
          delete pkg.dependencies[HOOKS_PACKAGE_NAME];
          if (Object.keys(pkg.dependencies).length === 0) {
            delete pkg.dependencies;
          }
          const remainingKeys = Object.keys(pkg).filter((k) => k !== "type");
          if (remainingKeys.length === 0) {
            await rm(pkgPath);
          } else {
            await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
          }
        }
      } catch {
        // Preserve user's package.json if it cannot be parsed
      }
    }
  }

  private generatePlugin(neededEvents: Set<string>): string {
    const busEvents = [...neededEvents].filter((e) => BUS_EVENTS.has(e));
    const hasToolBefore = neededEvents.has("tool.execute.before");
    const hasToolAfter = neededEvents.has("tool.execute.after");

    const hookParts: string[] = [];

    if (busEvents.length > 0) {
      hookParts.push(`    event: async ({ event }) => {
      if (event && SUBSCRIBED_BUS_EVENTS.has(event.type)) {
        await handleBusEvent(event, projectDir);
      }
    }`);
    }

    if (hasToolBefore) {
      hookParts.push(`    "tool.execute.before": async (input, output) => {
      await handleToolBefore(input, output, projectDir);
    }`);
    }

    if (hasToolAfter) {
      hookParts.push(`    "tool.execute.after": async (input, output) => {
      await handleToolAfter(input, output, projectDir);
    }`);
    }

    const hookEntries = hookParts.join(",\n");
    const projectRootLiteral = JSON.stringify(resolve(process.cwd()));
    const busEventsLiteral = JSON.stringify(busEvents);

    return `/**
 * ai-hooks plugin for OpenCode.
 * Generated by: ai-hooks generate
 *
 * This plugin hooks into OpenCode's lifecycle events and delegates
 * to the ai-hooks engine for unified hook management.
 *
 * DO NOT EDIT - regenerate with: ai-hooks generate
 */
import { loadConfig, HookEngine } from "${HOOKS_PACKAGE_NAME}";

const PROJECT_ROOT = ${projectRootLiteral};
const SUBSCRIBED_BUS_EVENTS = new Set(${busEventsLiteral});

const engines = new Map();

async function getEngine(projectDir) {
  const root = projectDir || PROJECT_ROOT;
  if (!engines.has(root)) {
    const config = await loadConfig(undefined, root);
    engines.set(root, new HookEngine(config));
  }
  return engines.get(root);
}

async function handleBusEvent(busEvent, projectDir) {
  const eng = await getEngine(projectDir);
  const toolInfo = { name: "opencode", version: "1.0" };
  const timestamp = Date.now();
  const metadata = {};
  const props = busEvent?.properties ?? busEvent ?? {};

  let event;
  switch (busEvent.type) {
    case "session.created":
      event = { type: "session:start", tool: "opencode", version: "1.0", workingDirectory: projectDir, timestamp, metadata };
      break;
    case "session.idle":
      event = { type: "session:end", tool: "opencode", duration: 0, timestamp, metadata };
      break;
    case "file.edited":
      event = { type: "file:edit", path: props.file ?? props.path ?? "", oldContent: "", newContent: "", timestamp, metadata };
      break;
    case "message.updated":
      event = { type: "prompt:submit", prompt: props.info?.content ?? props.content ?? props.text ?? "", timestamp, metadata };
      break;
    case "message.part.updated":
      event = { type: "prompt:response", response: props.part?.text ?? props.part?.content ?? props.content ?? "", model: props.part?.model ?? "unknown", tokens: { input: 0, output: 0 }, timestamp, metadata };
      break;
    case "tui.toast.show":
      event = { type: "notification", level: props.variant ?? props.level ?? "info", message: props.message ?? props.title ?? "", timestamp, metadata };
      break;
    default:
      return;
  }

  await eng.emit(event, toolInfo);
}

async function handleToolBefore(input, output, projectDir) {
  const eng = await getEngine(projectDir);
  const toolInfo = { name: "opencode", version: "1.0" };
  const timestamp = Date.now();
  const metadata = {};

  const event = resolveToolBefore(input, output, projectDir, timestamp, metadata);
  const results = await eng.emit(event, toolInfo);
  const blocked = results.find((r) => r.blocked);

  if (blocked) {
    throw new Error(blocked.reason ?? "Blocked by ai-hooks");
  }
}

async function handleToolAfter(input, output, projectDir) {
  const eng = await getEngine(projectDir);
  const toolInfo = { name: "opencode", version: "1.0" };
  const timestamp = Date.now();
  const metadata = {};

  const event = resolveToolAfter(input, output, projectDir, timestamp, metadata);
  await eng.emit(event, toolInfo);
}

function resolveToolBefore(input, output, projectDir, timestamp, metadata) {
  const toolName = input?.tool ?? input?.name ?? "unknown";
  const toolInput = output?.args ?? input?.args ?? input?.input ?? {};

  switch (toolName) {
    case "file_write":
    case "write":
      return { type: "file:write", path: toolInput.filePath ?? toolInput.path ?? "", content: toolInput.content ?? "", timestamp, metadata };
    case "file_edit":
    case "edit":
      return {
        type: "file:edit",
        path: toolInput.filePath ?? toolInput.path ?? "",
        oldContent: toolInput.oldString ?? toolInput.old ?? "",
        newContent: toolInput.newString ?? toolInput.new ?? "",
        timestamp,
        metadata,
      };
    case "file_read":
    case "read":
      return { type: "file:read", path: toolInput.filePath ?? toolInput.path ?? "", timestamp, metadata };
    case "bash":
    case "shell":
      return { type: "shell:before", command: toolInput.command ?? "", cwd: toolInput.workdir ?? projectDir, timestamp, metadata };
    default:
      return { type: "tool:before", toolName, input: toolInput, timestamp, metadata };
  }
}

function resolveToolAfter(input, output, projectDir, timestamp, metadata) {
  const toolName = input?.tool ?? input?.name ?? "unknown";
  const toolInput = input?.args ?? input?.input ?? {};
  const toolOutput = output ?? input?.output ?? input?.result ?? {};

  switch (toolName) {
    case "bash":
    case "shell":
      return {
        type: "shell:after",
        command: toolInput.command ?? "",
        cwd: toolInput.workdir ?? projectDir,
        exitCode: toolOutput.metadata?.exit ?? toolOutput.exitCode ?? 0,
        stdout: typeof toolOutput.output === "string" ? toolOutput.output : (toolOutput.stdout ?? ""),
        stderr: toolOutput.stderr ?? "",
        duration: 0,
        timestamp,
        metadata,
      };
    default:
      return { type: "tool:after", toolName, input: toolInput, output: toolOutput, duration: 0, timestamp, metadata };
  }
}

export const AiHooksPlugin = async ({ project, directory } = {}) => {
  const projectDir = directory || project?.worktree || PROJECT_ROOT;
  return {
${hookEntries}
  };
};
`;
  }
}

// Auto-register
const adapter = new OpenCodeAdapter();
registry.register(adapter);

export { OpenCodeAdapter };
export default adapter;
