import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HookContext, HookDefinition, HookEventType } from "../types/index.js";
import { AmpAdapter } from "./amp.js";
import { registry } from "./index.js";

function makeHandler() {
  return async (ctx: HookContext, next: () => Promise<void>) => {
    void ctx;
    await next();
  };
}

describe("AmpAdapter", () => {
  const dirs: string[] = [];
  const origCwd = process.cwd();
  const origAmpSettingsFile = process.env.AMP_SETTINGS_FILE;
  const origXdgConfigHome = process.env.XDG_CONFIG_HOME;

  afterEach(async () => {
    process.chdir(origCwd);
    if (origAmpSettingsFile === undefined) {
      delete process.env.AMP_SETTINGS_FILE;
    } else {
      process.env.AMP_SETTINGS_FILE = origAmpSettingsFile;
    }
    if (origXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdgConfigHome;
    }
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ai-tools-amp-hooks-"));
    dirs.push(dir);
    return dir;
  }

  const shellHook: HookDefinition = {
    id: "block-dangerous",
    name: "Block Dangerous Commands",
    events: ["shell:before"],
    phase: "before",
    handler: makeHandler(),
  };

  describe("metadata & capabilities", () => {
    it("registers itself in the hooks registry", () => {
      expect(registry.get("amp")).toBeInstanceOf(AmpAdapter);
    });

    it("has correct metadata and capabilities", () => {
      const adapter = new AmpAdapter();
      expect(adapter.id).toBe("amp");
      expect(adapter.name).toBe("Amp");
      expect(adapter.version).toBe("1.0");
      expect(adapter.capabilities.beforeHooks).toBe(true);
      expect(adapter.capabilities.afterHooks).toBe(true);
      expect(adapter.capabilities.mcp).toBe(true);
      expect(adapter.capabilities.configFile).toBe(true);
      for (const event of adapter.capabilities.blockableEvents) {
        expect(adapter.capabilities.supportedEvents).toContain(event);
      }
    });
  });

  describe("event mapping", () => {
    it("maps universal events to Amp plugin events", () => {
      const adapter = new AmpAdapter();
      expect(adapter.mapEvent("session:start")).toEqual(["session.start"]);
      expect(adapter.mapEvent("prompt:submit")).toEqual(["agent.start"]);
      expect(adapter.mapEvent("prompt:response")).toEqual(["agent.end"]);
      expect(adapter.mapEvent("session:end")).toEqual(["agent.end"]);
      expect(adapter.mapEvent("tool:before")).toEqual(["tool.call"]);
      expect(adapter.mapEvent("shell:before")).toEqual(["tool.call"]);
      expect(adapter.mapEvent("file:write")).toEqual(["tool.call"]);
      expect(adapter.mapEvent("mcp:before")).toEqual(["tool.call"]);
      expect(adapter.mapEvent("tool:after")).toEqual(["tool.result"]);
      expect(adapter.mapEvent("shell:after")).toEqual(["tool.result"]);
      expect(adapter.mapEvent("mcp:after")).toEqual(["tool.result"]);
      expect(adapter.mapEvent("unknown:event" as HookEventType)).toEqual([]);
    });

    it("maps native Amp events back to universal events", () => {
      const adapter = new AmpAdapter();
      expect(adapter.mapNativeEvent("session.start")).toEqual(["session:start"]);
      expect(adapter.mapNativeEvent("agent.start")).toEqual(["prompt:submit"]);
      expect(adapter.mapNativeEvent("agent.end")).toEqual(["prompt:response", "session:end"]);
      expect(adapter.mapNativeEvent("tool.call")).toEqual([
        "tool:before",
        "file:read",
        "file:write",
        "file:edit",
        "file:delete",
        "shell:before",
        "mcp:before",
      ]);
      expect(adapter.mapNativeEvent("tool.result")).toEqual([
        "tool:after",
        "shell:after",
        "mcp:after",
      ]);
      expect(adapter.mapNativeEvent("unknown")).toEqual([]);
    });
  });

  describe("generate", () => {
    it("generates .amp/plugins/ai-tools-hooks.ts using @ampcode/plugin and reject-and-continue", async () => {
      const cwd = await scratch();
      process.chdir(cwd);

      const adapter = new AmpAdapter();
      const configs = await adapter.generate([
        shellHook,
        {
          id: "lifecycle",
          name: "Lifecycle",
          events: ["session:start", "prompt:submit", "prompt:response", "tool:after"],
          phase: "after",
          handler: makeHandler(),
        },
      ]);

      expect(configs).toHaveLength(1);
      const plugin = configs[0]!;
      expect(plugin.path).toBe(".amp/plugins/ai-tools-hooks.ts");
      expect(plugin.format).toBe("ts");
      expect(plugin.content).toContain('import type { PluginAPI } from "@ampcode/plugin";');
      expect(plugin.content).toContain(
        `const PROJECT_ROOT = ${JSON.stringify(resolve(process.cwd()))};`,
      );
      expect(plugin.content).toContain('action: "reject-and-continue"');
      expect(plugin.content).toContain('amp.on("session.start"');
      expect(plugin.content).toContain('amp.on("agent.start"');
      expect(plugin.content).toContain('amp.on("agent.end"');
      expect(plugin.content).toContain('amp.on("tool.call"');
      expect(plugin.content).toContain('amp.on("tool.result"');
    });

    it("deduplicates native event registrations across hooks", async () => {
      const adapter = new AmpAdapter();
      const configs = await adapter.generate([
        shellHook,
        {
          id: "file-guard",
          name: "File Guard",
          events: ["file:write", "tool:before"],
          phase: "before",
          handler: makeHandler(),
        },
      ]);

      const matches = configs[0]!.content.match(/amp\.on\("tool\.call"/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe("install, uninstall, and detect", () => {
    it("installs and uninstalls .amp/plugins/ai-tools-hooks.ts in the working directory", async () => {
      const cwd = await scratch();
      process.chdir(cwd);

      const adapter = new AmpAdapter();
      const configs = await adapter.generate([shellHook]);
      await adapter.install(configs);

      const pluginPath = join(cwd, ".amp/plugins/ai-tools-hooks.ts");
      expect(existsSync(pluginPath)).toBe(true);
      expect(await readFile(pluginPath, "utf-8")).toContain('amp.on("tool.call"');

      await adapter.uninstall();
      expect(existsSync(pluginPath)).toBe(false);
    });

    it("detects .amp directory and AMP_SETTINGS_FILE", async () => {
      const cwd = await scratch();
      const userDir = await scratch();
      const userFile = join(userDir, "settings.json");
      process.chdir(cwd);
      process.env.AMP_SETTINGS_FILE = userFile;

      const adapter = new AmpAdapter();
      vi.spyOn(
        adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
        "commandExists",
      ).mockResolvedValue(false);

      expect(await adapter.detect()).toBe(false);

      await writeFile(userFile, "{}\n", "utf-8");
      expect(await adapter.detect()).toBe(true);

      await rm(userFile);
      await mkdir(join(cwd, ".amp"), { recursive: true });
      expect(await adapter.detect()).toBe(true);
    });
  });
});
