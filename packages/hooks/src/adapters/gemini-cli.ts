import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BaseAdapter, registry } from "./index.js";
import {
  asRecord,
  collectNativeEvents,
  stringField,
  type NativeHookGroup,
} from "./claude-compat.js";
import type {
  AdapterCapabilities,
  GeneratedConfig,
  HookDefinition,
  HookEventType,
} from "../types/index.js";

/**
 * Event mapping: ai-hooks universal events -> Gemini CLI native hooks.
 *
 * Gemini CLI reads hooks from `.gemini/settings.json` (project) and
 * `~/.gemini/settings.json` (user) under `hooks.<EventName>`.
 */
const EVENT_MAP: Record<string, string[]> = {
  "session:start": ["SessionStart"],
  "session:end": ["SessionEnd"],
  "prompt:submit": ["BeforeAgent"],
  "prompt:response": ["AfterAgent"],
  "tool:before": ["BeforeTool"],
  "tool:after": ["AfterTool"],
  "file:read": ["BeforeTool"],
  "file:write": ["BeforeTool"],
  "file:edit": ["BeforeTool"],
  "file:delete": ["BeforeTool"],
  "shell:before": ["BeforeTool"],
  "shell:after": ["AfterTool"],
  "mcp:before": ["BeforeTool"],
  "mcp:after": ["AfterTool"],
  notification: ["Notification"],
};

const REVERSE_MAP: Record<string, HookEventType[]> = {
  SessionStart: ["session:start"],
  SessionEnd: ["session:end"],
  BeforeAgent: ["prompt:submit"],
  AfterAgent: ["prompt:response"],
  BeforeTool: [
    "tool:before",
    "file:read",
    "file:write",
    "file:edit",
    "file:delete",
    "shell:before",
    "mcp:before",
  ],
  AfterTool: ["tool:after", "shell:after", "mcp:after"],
  Notification: ["notification"],
};

const TOOL_MATCHER_EVENTS = new Set(["BeforeTool", "AfterTool"]);
const BEFORE_NATIVE_EVENTS = new Set(["SessionStart", "BeforeAgent", "BeforeTool"]);

const SETTINGS_JSON = ".gemini/settings.json";
const RUNNER_JS = ".gemini/hooks/ai-tools-runner.js";
const RUNNER_COMMAND = "node .gemini/hooks/ai-tools-runner.js";

class GeminiCliAdapter extends BaseAdapter {
  readonly id = "gemini-cli";
  readonly name = "Gemini CLI";
  readonly version = "1.0";
  readonly userSettingsPath = join(homedir(), ".gemini", "settings.json");

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
      "file:write",
      "file:edit",
      "file:delete",
      "shell:before",
      "mcp:before",
    ],
  };

  async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    const hasConfig = existsSync(resolve(dir, ".gemini"));
    if (hasConfig) return true;
    return this.commandExists("gemini");
  }

  async generate(hooks: HookDefinition[]): Promise<GeneratedConfig[]> {
    const nativeEvents = collectNativeEvents(hooks, (event) => this.mapEvent(event));
    const groups = this.buildGroups(nativeEvents);
    const mergedSettings = await this.mergeSettingsFile(
      resolve(process.cwd(), SETTINGS_JSON),
      groups,
    );

    return [
      {
        path: RUNNER_JS,
        content: this.generateRunner(),
        format: "js",
      },
      {
        path: SETTINGS_JSON,
        content: `${JSON.stringify(mergedSettings, null, 2)}\n`,
        format: "json",
      },
    ];
  }

  override async install(configs: GeneratedConfig[]): Promise<void> {
    for (const config of configs) {
      const fullPath = resolve(process.cwd(), config.path);
      await mkdir(dirname(fullPath), { recursive: true });
      if (config.path === SETTINGS_JSON && existsSync(fullPath)) {
        const incoming = parseJsonRecord(config.content);
        const incomingHooks = keepOnlyAiToolsHooks(asRecord(incoming.hooks));
        const merged = await this.mergeSettingsFile(fullPath, incomingHooks);
        await writeFile(fullPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
      } else {
        await writeFile(fullPath, config.content, "utf-8");
      }
    }
  }

  async import(cwd?: string): Promise<HookDefinition[]> {
    const dir = cwd ?? process.cwd();
    return this.importSettingsFile(resolve(dir, SETTINGS_JSON), "gemini-cli");
  }

  async importUser(): Promise<HookDefinition[]> {
    return this.importSettingsFile(this.userSettingsPath, "gemini-cli-user");
  }

  mapEvent(event: HookEventType): string[] {
    return EVENT_MAP[event] ?? [];
  }

  mapNativeEvent(nativeEvent: string): HookEventType[] {
    return REVERSE_MAP[nativeEvent] ?? [];
  }

  async uninstall(): Promise<void> {
    await this.removeFile(RUNNER_JS);
    await this.stripSettingsHooks(resolve(process.cwd(), SETTINGS_JSON));
  }

  private buildGroups(nativeEvents: string[]): Record<string, NativeHookGroup[]> {
    const groups: Record<string, NativeHookGroup[]> = {};
    for (const native of nativeEvents) {
      const group: NativeHookGroup = {
        ...(TOOL_MATCHER_EVENTS.has(native) ? { matcher: "*" } : {}),
        hooks: [
          {
            type: "command",
            command: RUNNER_COMMAND,
          },
        ],
      };
      groups[native] = [group];
    }
    return groups;
  }

  private generateRunner(): string {
    return `#!/usr/bin/env node
/**
 * ai-hooks runner for Gemini CLI.
 * Generated by: ai-hooks generate
 *
 * Gemini CLI sends the hook payload as JSON on stdin and reads
 * {"decision":"deny","reason":"..."} from stdout on exit 0.
 *
 * DO NOT EDIT - regenerate with: ai-hooks generate
 */
import { runGeminiHook } from "@itz4blitz/ai-tools-hooks";

const PROJECT_ROOT = ${JSON.stringify(resolve(process.cwd()))};
process.chdir(PROJECT_ROOT);

process.exit(await runGeminiHook());
`;
  }

  private async mergeSettingsFile(
    fullPath: string,
    incomingHooks: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const existing = await this.readJsonRecord(fullPath);
    const existingHooks = asRecord(existing.hooks);
    const mergedHooks: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(existingHooks)) {
      if (Array.isArray(value)) {
        const kept = stripAiToolsGroups(value);
        if (kept.length > 0) {
          mergedHooks[key] = kept;
        }
      } else {
        mergedHooks[key] = value;
      }
    }

    for (const [event, entries] of Object.entries(incomingHooks)) {
      if (!Array.isArray(entries)) continue;
      const current = Array.isArray(mergedHooks[event]) ? (mergedHooks[event] as unknown[]) : [];
      const incoming = entries.filter((entry) => {
        const group = asRecord(entry);
        return Array.isArray(group.hooks) && group.hooks.length > 0;
      });
      if (current.length > 0 || incoming.length > 0) {
        mergedHooks[event] = [...current, ...incoming];
      }
    }

    return {
      ...existing,
      hooks: mergedHooks,
    };
  }

  private async stripSettingsHooks(fullPath: string): Promise<void> {
    if (!existsSync(fullPath)) return;
    const existing = await this.readJsonRecord(fullPath);
    if (Object.keys(existing).length === 0) return;

    const existingHooks = asRecord(existing.hooks);
    if (Object.keys(existingHooks).length === 0) return;

    const strippedHooks: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(existingHooks)) {
      if (Array.isArray(value)) {
        const kept = stripAiToolsGroups(value);
        if (kept.length > 0) {
          strippedHooks[key] = kept;
        }
      } else {
        strippedHooks[key] = value;
      }
    }

    const next: Record<string, unknown> = { ...existing };
    if (Object.keys(strippedHooks).length > 0) {
      next.hooks = strippedHooks;
    } else {
      delete next.hooks;
    }

    await writeFile(fullPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  }

  private async importSettingsFile(fullPath: string, source: string): Promise<HookDefinition[]> {
    const data = await this.readJsonRecord(fullPath);
    const hooksMap = asRecord(data.hooks);
    const imported: HookDefinition[] = [];

    for (const [nativeEvent, groups] of Object.entries(hooksMap)) {
      if (!Array.isArray(groups)) continue;
      const events = this.mapNativeEvent(nativeEvent);
      if (events.length === 0) continue;
      const phase = BEFORE_NATIVE_EVENTS.has(nativeEvent) ? "before" : "after";

      groups.forEach((group, groupIndex) => {
        const typedGroup = asRecord(group);
        const entries = typedGroup.hooks;
        if (!Array.isArray(entries)) return;
        entries.forEach((entry, hookIndex) => {
          const hookObj = asRecord(entry);
          const command = stringField(hookObj.command);
          if (!command) return;
          imported.push({
            id: `${source}-${nativeEvent}-${groupIndex}-${hookIndex}`,
            name: stringField(hookObj.name) || command,
            description: stringField(hookObj.description) || `${source} ${nativeEvent}`,
            events,
            phase,
            handler: async (_ctx, next) => {
              await next();
            },
          });
        });
      });
    }

    return imported;
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
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function isAiToolsCommand(hook: unknown): boolean {
  const command = asRecord(hook).command;
  return typeof command === "string" && command.includes("ai-tools-runner.js");
}

function stripAiToolsGroups(entries: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const entry of entries) {
    const group = asRecord(entry);
    if (!Array.isArray(group.hooks)) {
      result.push(entry);
      continue;
    }
    const keptHooks = group.hooks.filter((hook) => !isAiToolsCommand(hook));
    if (keptHooks.length > 0) {
      result.push({ ...group, hooks: keptHooks });
    }
  }
  return result;
}

function keepOnlyAiToolsHooks(hooksMap: Record<string, unknown>): Record<string, unknown[]> {
  const result: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries(hooksMap)) {
    if (!Array.isArray(entries)) continue;
    const aiGroups: unknown[] = [];
    for (const entry of entries) {
      const group = asRecord(entry);
      if (!Array.isArray(group.hooks)) continue;
      const aiHooks = group.hooks.filter((hook) => isAiToolsCommand(hook));
      if (aiHooks.length > 0) {
        aiGroups.push({ ...group, hooks: aiHooks });
      }
    }
    if (aiGroups.length > 0) {
      result[event] = aiGroups;
    }
  }
  return result;
}

const adapter = new GeminiCliAdapter();
registry.register(adapter);

export { GeminiCliAdapter };
export default adapter;
