import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BaseAdapter, registry } from "./index.js";
import { collectNativeEvents, parseHookGroups, type NativeHookGroup } from "./claude-compat.js";
import type {
  AdapterCapabilities,
  GeneratedConfig,
  HookDefinition,
  HookEventType,
} from "../types/index.js";

/**
 * ZCode loads configuration-file hooks from:
 *   - workspace `<repo>/.zcode/config.json` (or `zcode.json`) → hooks.events
 *   - user `~/.zcode/cli/config.json` → hooks.events (requires hooks.enabled)
 *   - user `~/.zcode/hooks.json` → { version, hooks } (Claude-compatible)
 *
 * Supported events: SessionStart, UserPromptSubmit, PreToolUse,
 * PermissionRequest, PostToolUse, PostToolUseFailure, Stop.
 */
const EVENT_MAP: Record<string, string[]> = {
  "session:start": ["SessionStart"],
  "session:end": ["Stop"],
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
  notification: [],
};

const REVERSE_MAP: Record<string, HookEventType[]> = {
  SessionStart: ["session:start"],
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
  PermissionRequest: ["tool:before"],
  PostToolUse: ["tool:after", "shell:after", "mcp:after"],
  PostToolUseFailure: ["tool:after"],
  Stop: ["session:end", "prompt:response"],
};

const HOOKS_JSON = ".zcode/hooks.json";
const CONFIG_JSON = ".zcode/config.json";
const RUNNER_JS = ".zcode/hooks/ai-tools-runner.js";

function buildRunnerCommand(cwd = process.cwd()): string {
  const runnerPath = resolve(cwd, RUNNER_JS).replaceAll("\\", "/");
  return `node ${JSON.stringify(runnerPath)}`;
}

class ZcodeAdapter extends BaseAdapter {
  readonly id = "zcode";
  readonly name = "ZCode";
  readonly version = "1.0";
  readonly userConfigPath = join(homedir(), ".zcode", "cli", "config.json");
  readonly userHooksPath = join(homedir(), ".zcode", "hooks.json");

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
    if (await this.commandExists("zcode")) return true;
    if (existsSync(resolve(process.cwd(), ".zcode"))) return true;
    if (existsSync(this.userConfigPath) || existsSync(this.userHooksPath)) return true;
    return false;
  }

  async generate(hooks: HookDefinition[]): Promise<GeneratedConfig[]> {
    const nativeEvents = collectNativeEvents(hooks, (event) => this.mapEvent(event));
    const groups = this.buildGroups(nativeEvents);
    const config = await this.mergeWorkspaceConfig(groups);

    return [
      {
        path: CONFIG_JSON,
        content: `${JSON.stringify(config, null, 2)}\n`,
        format: "json",
      },
      {
        path: RUNNER_JS,
        content: this.generateRunner(),
        format: "js",
      },
    ];
  }

  async import(cwd?: string): Promise<HookDefinition[]> {
    const dir = cwd ?? process.cwd();
    const imported: HookDefinition[] = [];
    imported.push(
      ...(await this.importHooksFile(resolve(dir, HOOKS_JSON), "zcode")),
      ...(await this.importConfigFile(resolve(dir, CONFIG_JSON), "zcode")),
      ...(await this.importConfigFile(resolve(dir, "zcode.json"), "zcode")),
    );
    return imported;
  }

  async importUser(): Promise<HookDefinition[]> {
    return [
      ...(await this.importHooksFile(this.userHooksPath, "zcode-user")),
      ...(await this.importConfigFile(this.userConfigPath, "zcode-user")),
    ];
  }

  mapEvent(event: HookEventType): string[] {
    return EVENT_MAP[event] ?? [];
  }

  mapNativeEvent(nativeEvent: string): HookEventType[] {
    return REVERSE_MAP[nativeEvent] ?? [];
  }

  async uninstall(): Promise<void> {
    await this.removeFile(RUNNER_JS);
    await this.stripWorkspaceConfig();
  }

  private buildGroups(nativeEvents: string[]): Record<string, NativeHookGroup[]> {
    const command = buildRunnerCommand();
    const groups: Record<string, NativeHookGroup[]> = {};
    for (const native of nativeEvents) {
      groups[native] = [
        {
          hooks: [
            {
              type: "command",
              command,
              timeout: 10,
              statusMessage: "ai-hooks",
            },
          ],
        },
      ];
    }
    return groups;
  }

  private generateRunner(): string {
    return `#!/usr/bin/env node
/**
 * ai-hooks runner for ZCode.
 * Generated by: ai-hooks generate
 *
 * ZCode sends the event as JSON on stdin. Blocking events deny with exit 2.
 *
 * DO NOT EDIT - regenerate with: ai-hooks generate
 */
import { runZcodeHook } from "@itz4blitz/ai-tools-hooks";

const PROJECT_ROOT = ${JSON.stringify(resolve(process.cwd()))};
process.chdir(PROJECT_ROOT);

process.exit(await runZcodeHook());
`;
  }

  private async mergeWorkspaceConfig(
    groups: Record<string, NativeHookGroup[]>,
  ): Promise<Record<string, unknown>> {
    const existing = await this.readJsonRecord(resolve(process.cwd(), CONFIG_JSON));
    const existingHooks = asObject(existing.hooks);
    const existingEvents = asObject(existingHooks.events);
    const mergedEvents: Record<string, unknown> = {};

    for (const [event, entries] of Object.entries(existingEvents)) {
      const kept = stripAiHooksGroups(entries);
      if (kept.length > 0) mergedEvents[event] = kept;
    }
    for (const [event, entries] of Object.entries(groups)) {
      if (entries.length === 0) continue;
      const current = Array.isArray(mergedEvents[event]) ? mergedEvents[event] : [];
      mergedEvents[event] = [...current, ...entries];
    }

    return {
      ...existing,
      hooks: {
        ...existingHooks,
        enabled: true,
        events: mergedEvents,
      },
    };
  }

  private async stripWorkspaceConfig(): Promise<void> {
    const fullPath = resolve(process.cwd(), CONFIG_JSON);
    const existing = await this.readJsonRecord(fullPath);
    if (Object.keys(existing).length === 0) return;
    const existingHooks = asObject(existing.hooks);
    const existingEvents = asObject(existingHooks.events);
    const stripped: Record<string, unknown> = {};
    for (const [event, entries] of Object.entries(existingEvents)) {
      const kept = stripAiHooksGroups(entries);
      if (kept.length > 0) stripped[event] = kept;
    }

    const nextHooks: Record<string, unknown> = { ...existingHooks };
    if (Object.keys(stripped).length > 0) {
      nextHooks.events = stripped;
    } else {
      delete nextHooks.events;
      delete nextHooks.enabled;
    }

    const next: Record<string, unknown> = { ...existing };
    if (Object.keys(nextHooks).length > 0) {
      next.hooks = nextHooks;
    } else {
      delete next.hooks;
    }

    if (Object.keys(next).length === 0) {
      await this.removeFile(CONFIG_JSON);
      return;
    }

    await this.writeJsonFile(CONFIG_JSON, next);
  }

  private async importHooksFile(fullPath: string, source: string): Promise<HookDefinition[]> {
    const data = await this.readJsonRecord(fullPath);
    return this.definitionsFromEvents(asObject(data.hooks), source);
  }

  private async importConfigFile(fullPath: string, source: string): Promise<HookDefinition[]> {
    const data = await this.readJsonRecord(fullPath);
    const hooks = asObject(data.hooks);
    return this.definitionsFromEvents(asObject(hooks.events), source);
  }

  private definitionsFromEvents(events: Record<string, unknown>, source: string): HookDefinition[] {
    const imported: HookDefinition[] = [];
    for (const [nativeEvent, groups] of Object.entries(events)) {
      imported.push(
        ...parseHookGroups(groups, nativeEvent, (event) => this.mapNativeEvent(event), source),
      );
    }
    return imported;
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
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stripAiHooksGroups(entries: unknown): NativeHookGroup[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => {
    const group = asObject(entry);
    const hooks = group.hooks;
    if (!Array.isArray(hooks)) return true;
    return !hooks.some((hook) => {
      const command = asObject(hook).command;
      return typeof command === "string" && command.includes("ai-tools-runner.js");
    });
  }) as NativeHookGroup[];
}

const adapter = new ZcodeAdapter();
registry.register(adapter);
export { ZcodeAdapter };
export default adapter;
