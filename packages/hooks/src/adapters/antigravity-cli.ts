import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  AdapterCapabilities,
  GeneratedConfig,
  HookDefinition,
  HookEventType,
} from "../types/index.js";
import { asRecord, collectNativeEvents, stringField } from "./claude-compat.js";
import { BaseAdapter, registry } from "./index.js";

const EVENT_MAP: Record<string, string[]> = {
  "session:start": ["SessionStart"],
  "session:end": ["Stop"],
  "prompt:submit": ["PreInvocation"],
  "prompt:response": ["PostInvocation"],
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
  SessionStart: ["session:start"],
  PreInvocation: ["prompt:submit"],
  PostInvocation: ["prompt:response"],
  Stop: ["session:end"],
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
};

const GROUPED_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const HOOKS_JSON = ".agents/hooks.json";
const RUNNER_JS = ".agents/hooks/ai-tools-runner.js";
const RUNNER_COMMAND = "node .agents/hooks/ai-tools-runner.js";
const NAMED_GROUP_KEY = "ai-tools";

type FlatCommandHook = {
  type: "command";
  command: string;
  timeout: number;
};

type GroupedCommandHook = {
  matcher: string;
  hooks: FlatCommandHook[];
};

export class AntigravityCliAdapter extends BaseAdapter {
  readonly id = "antigravity-cli";
  readonly name = "Antigravity CLI";
  readonly version = "1.0";
  readonly userHooksPath = join(homedir(), ".gemini", "config", "hooks.json");

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
      "session:end",
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
    if (await this.commandExists("agy")) return true;
    if (existsSync(resolve(process.cwd(), HOOKS_JSON))) return true;
    if (existsSync(resolve(process.cwd(), ".agents"))) return true;
    if (existsSync(this.userHooksPath)) return true;
    if (existsSync(join(homedir(), ".gemini", "antigravity-cli", "settings.json"))) return true;
    return false;
  }

  async generate(hooks: HookDefinition[]): Promise<GeneratedConfig[]> {
    const nativeEvents = collectNativeEvents(hooks, (event) => this.mapEvent(event));
    const eventsTable: Record<string, FlatCommandHook[] | GroupedCommandHook[]> = {};

    const commandEntry: FlatCommandHook = {
      type: "command",
      command: RUNNER_COMMAND,
      timeout: 10,
    };

    for (const nativeEvent of nativeEvents) {
      if (GROUPED_EVENTS.has(nativeEvent)) {
        eventsTable[nativeEvent] = [{ matcher: "*", hooks: [commandEntry] }];
      } else {
        eventsTable[nativeEvent] = [commandEntry];
      }
    }

    return [
      {
        path: HOOKS_JSON,
        content: `${JSON.stringify({ [NAMED_GROUP_KEY]: eventsTable }, null, 2)}\n`,
        format: "json",
      },
      {
        path: RUNNER_JS,
        content: this.generateRunner(),
        format: "js",
      },
    ];
  }

  override async install(configs: GeneratedConfig[]): Promise<void> {
    for (const config of configs) {
      const fullPath = resolve(process.cwd(), config.path);
      await mkdir(dirname(fullPath), { recursive: true });

      if (config.path === HOOKS_JSON && existsSync(fullPath)) {
        const existing = await this.readJsonRecord(fullPath);
        const generated = parseJsonRecord(config.content);
        const merged = {
          ...existing,
          [NAMED_GROUP_KEY]: generated[NAMED_GROUP_KEY] ?? {},
        };
        await writeFile(fullPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
        continue;
      }

      await writeFile(fullPath, config.content, "utf-8");
    }
  }

  async import(cwd?: string): Promise<HookDefinition[]> {
    const dir = cwd ?? process.cwd();
    return this.importHooksFile(resolve(dir, HOOKS_JSON), "antigravity-cli");
  }

  async importUser(): Promise<HookDefinition[]> {
    return this.importHooksFile(this.userHooksPath, "antigravity-cli-user");
  }

  mapEvent(event: HookEventType): string[] {
    return EVENT_MAP[event] ?? [];
  }

  mapNativeEvent(nativeEvent: string): HookEventType[] {
    return REVERSE_MAP[nativeEvent] ?? [];
  }

  override async uninstall(): Promise<void> {
    await this.removeFile(RUNNER_JS);

    const hooksFullPath = resolve(process.cwd(), HOOKS_JSON);
    if (!existsSync(hooksFullPath)) return;

    const existing = await this.readJsonRecord(hooksFullPath);
    if (!(NAMED_GROUP_KEY in existing)) return;

    const remaining: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(existing)) {
      if (key !== NAMED_GROUP_KEY) {
        remaining[key] = value;
      }
    }

    if (Object.keys(remaining).length === 0) {
      await this.removeFile(HOOKS_JSON);
    } else {
      await this.writeJsonFile(HOOKS_JSON, remaining);
    }
  }

  private generateRunner(): string {
    return `#!/usr/bin/env node
/**
 * ai-hooks runner for Antigravity CLI.
 * Generated by: ai-hooks generate
 *
 * Antigravity CLI sends camelCase JSON on stdin and reads structured JSON from stdout.
 *
 * DO NOT EDIT - regenerate with: ai-hooks generate
 */
import { runAntigravityCliHook } from "@itz4blitz/ai-tools-hooks";

const PROJECT_ROOT = ${JSON.stringify(resolve(process.cwd()))};
process.chdir(PROJECT_ROOT);

process.exit(await runAntigravityCliHook());
`;
  }

  private async importHooksFile(fullPath: string, source: string): Promise<HookDefinition[]> {
    const data = await this.readJsonRecord(fullPath);
    if (Object.keys(data).length === 0) return [];

    const imported: HookDefinition[] = [];
    for (const [topKey, topValue] of Object.entries(data)) {
      if (this.mapNativeEvent(topKey).length > 0) {
        imported.push(...this.parseEventEntries(topValue, topKey, source, "default"));
        continue;
      }

      const groupRecord = asRecord(topValue);
      for (const [nativeEvent, entries] of Object.entries(groupRecord)) {
        if (this.mapNativeEvent(nativeEvent).length === 0) continue;
        imported.push(...this.parseEventEntries(entries, nativeEvent, source, topKey));
      }
    }

    return imported;
  }

  private parseEventEntries(
    entries: unknown,
    nativeEvent: string,
    source: string,
    groupName: string,
  ): HookDefinition[] {
    if (!Array.isArray(entries)) return [];
    const events = this.mapNativeEvent(nativeEvent);
    if (events.length === 0) return [];
    const phase = phaseForNativeEvent(nativeEvent);
    const definitions: HookDefinition[] = [];

    entries.forEach((entry, entryIndex) => {
      const record = asRecord(entry);
      if (Array.isArray(record.hooks)) {
        record.hooks.forEach((nested, nestedIndex) => {
          const nestedRecord = asRecord(nested);
          const command = stringField(nestedRecord.command);
          if (!command) return;
          definitions.push({
            id: `${source}-${groupName}-${nativeEvent}-${entryIndex}-${nestedIndex}`,
            name: command,
            description: `${source} ${groupName} ${nativeEvent}`,
            events,
            phase,
            handler: async (_ctx, next) => {
              await next();
            },
          });
        });
        return;
      }

      const command = stringField(record.command);
      if (!command) return;
      definitions.push({
        id: `${source}-${groupName}-${nativeEvent}-${entryIndex}`,
        name: command,
        description: `${source} ${groupName} ${nativeEvent}`,
        events,
        phase,
        handler: async (_ctx, next) => {
          await next();
        },
      });
    });

    return definitions;
  }

  private async readJsonRecord(fullPath: string): Promise<Record<string, unknown>> {
    if (!existsSync(fullPath)) return {};
    try {
      return parseJsonRecord(await readFile(fullPath, "utf-8"));
    } catch {
      return {};
    }
  }
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {};
  }
}

function phaseForNativeEvent(nativeEvent: string): "before" | "after" {
  if (
    nativeEvent === "PreToolUse" ||
    nativeEvent === "PreInvocation" ||
    nativeEvent === "SessionStart"
  ) {
    return "before";
  }
  return "after";
}

const adapter = new AntigravityCliAdapter();
registry.register(adapter);
export default adapter;
