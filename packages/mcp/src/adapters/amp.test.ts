import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MCPServerDefinition } from "../types/index.js";
import { AmpMCPAdapter, resolveAmpUserConfigPath, stripJsoncComments } from "./amp.js";

describe("AmpMCPAdapter", () => {
  const dirs: string[] = [];
  const origAmpSettingsFile = process.env.AMP_SETTINGS_FILE;
  const origXdgConfigHome = process.env.XDG_CONFIG_HOME;

  afterEach(async () => {
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
    const dir = await mkdtemp(join(tmpdir(), "ai-tools-amp-mcp-"));
    dirs.push(dir);
    return dir;
  }

  const stdioServer: MCPServerDefinition = {
    id: "github",
    name: "GitHub",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "tok" },
    },
  };

  const httpServer: MCPServerDefinition = {
    id: "linear",
    name: "Linear",
    transport: {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer secret" },
    },
  };

  const sseServer: MCPServerDefinition = {
    id: "events",
    name: "Events",
    transport: {
      type: "sse",
      url: "http://localhost:3000/sse",
    },
  };

  describe("metadata & userConfigPath", () => {
    it("has correct id, name, nativeSupport, and configPath", () => {
      const adapter = new AmpMCPAdapter();
      expect(adapter.id).toBe("amp");
      expect(adapter.name).toBe("Amp");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configPath).toBe(".amp/settings.json");
    });

    it("resolves default userConfigPath under ~/.config/amp/settings.json", () => {
      delete process.env.AMP_SETTINGS_FILE;
      delete process.env.XDG_CONFIG_HOME;
      expect(resolveAmpUserConfigPath()).toBe(join(homedir(), ".config", "amp", "settings.json"));
    });

    it("honors XDG_CONFIG_HOME when AMP_SETTINGS_FILE is unset", async () => {
      const dir = await scratch();
      delete process.env.AMP_SETTINGS_FILE;
      process.env.XDG_CONFIG_HOME = dir;
      expect(resolveAmpUserConfigPath()).toBe(join(dir, "amp", "settings.json"));
    });

    it("honors AMP_SETTINGS_FILE over XDG_CONFIG_HOME", async () => {
      const dir = await scratch();
      const customFile = join(dir, "custom-amp.json");
      process.env.XDG_CONFIG_HOME = join(dir, "xdg");
      process.env.AMP_SETTINGS_FILE = customFile;
      const adapter = new AmpMCPAdapter();
      expect(adapter.userConfigPath).toBe(resolve(customFile));
    });
  });

  describe("stripJsoncComments", () => {
    it("strips line comments, block comments, and trailing commas while preserving URLs in strings", () => {
      const raw = `{
  // Amp settings comment
  "$schema": "https://ampcode.com/schemas/settings.json",
  /* Block comment
     spanning lines */
  "amp.mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp", // inline comment
    },
  },
}`;
      const parsed = JSON.parse(stripJsoncComments(raw)) as Record<string, unknown>;
      expect(parsed.$schema).toBe("https://ampcode.com/schemas/settings.json");
      expect(parsed["amp.mcpServers"]).toEqual({
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
      });
    });
  });

  describe("generate", () => {
    it("writes amp.mcpServers to .amp/settings.json and preserves http vs sse", async () => {
      const adapter = new AmpMCPAdapter();
      const files = await adapter.generate([stdioServer, httpServer, sseServer]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(".amp/settings.json");
      expect(files[0]!.format).toBe("json");

      const parsed = JSON.parse(files[0]!.content) as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      expect(parsed.mcpServers).toBeUndefined();
      expect(parsed["amp.mcpServers"]!.github).toEqual({
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "tok" },
      });
      expect(parsed["amp.mcpServers"]!.linear).toEqual({
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer secret" },
      });
      expect(parsed["amp.mcpServers"]!.events).toEqual({
        type: "sse",
        url: "http://localhost:3000/sse",
      });
    });

    it("omits empty args, env, and headers", async () => {
      const adapter = new AmpMCPAdapter();
      const files = await adapter.generate([
        {
          id: "minimal-stdio",
          name: "Minimal Stdio",
          transport: { type: "stdio", command: "node", args: [], env: {} },
        },
        {
          id: "minimal-http",
          name: "Minimal HTTP",
          transport: { type: "http", url: "https://example.com/mcp", headers: {} },
        },
      ]);
      const parsed = JSON.parse(files[0]!.content) as {
        "amp.mcpServers": Record<string, Record<string, unknown>>;
      };
      expect(parsed["amp.mcpServers"]["minimal-stdio"]).toEqual({ command: "node" });
      expect(parsed["amp.mcpServers"]["minimal-http"]).toEqual({
        type: "http",
        url: "https://example.com/mcp",
      });
    });
  });

  describe("install, import, importUser, detect, uninstall", () => {
    it("merges into existing JSONC .amp/settings.json without clobbering unrelated keys", async () => {
      const cwd = await scratch();
      await mkdir(join(cwd, ".amp"), { recursive: true });
      await writeFile(
        join(cwd, ".amp/settings.json"),
        `{
  // Existing settings
  "$schema": "https://ampcode.com/schemas/settings.json",
  "amp.permissions": [{ "tool": "Bash", "action": "allow" }],
  "amp.mcpServers": {
    "existing": { "command": "keep-me" },
  },
}\n`,
        "utf-8",
      );

      const adapter = new AmpMCPAdapter();
      const files = await adapter.generate([httpServer, sseServer]);
      await adapter.install(files, cwd);

      const parsed = JSON.parse(await readFile(join(cwd, ".amp/settings.json"), "utf-8")) as Record<
        string,
        unknown
      >;
      expect(parsed.$schema).toBe("https://ampcode.com/schemas/settings.json");
      expect(parsed["amp.permissions"]).toEqual([{ tool: "Bash", action: "allow" }]);
      expect(parsed["amp.mcpServers"]).toEqual({
        existing: { command: "keep-me" },
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer secret" },
        },
        events: {
          type: "sse",
          url: "http://localhost:3000/sse",
        },
      });
    });

    it("round-trips stdio, http, and sse servers via install and import", async () => {
      const cwd = await scratch();
      const adapter = new AmpMCPAdapter();
      await adapter.install(await adapter.generate([stdioServer, httpServer, sseServer]), cwd);

      const imported = await adapter.import(cwd);
      expect(imported).toHaveLength(3);
      expect(imported.find((s) => s.id === "github")?.transport).toEqual(stdioServer.transport);
      expect(imported.find((s) => s.id === "linear")?.transport).toEqual(httpServer.transport);
      expect(imported.find((s) => s.id === "events")?.transport).toEqual(sseServer.transport);
    });

    it("imports from userConfigPath via importUser()", async () => {
      const dir = await scratch();
      const userFile = join(dir, "amp-settings.json");
      process.env.AMP_SETTINGS_FILE = userFile;

      await writeFile(
        userFile,
        `{
  // User-global MCP config
  "amp.mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
    },
  },
}\n`,
        "utf-8",
      );

      const adapter = new AmpMCPAdapter();
      const imported = await adapter.importUser();
      expect(imported).toEqual([
        {
          id: "linear",
          name: "linear",
          transport: { type: "http", url: "https://mcp.linear.app/mcp" },
        },
      ]);
    });

    it("detects project .amp/settings.json and userConfigPath", async () => {
      const cwd = await scratch();
      const userDir = await scratch();
      const userFile = join(userDir, "settings.json");
      process.env.AMP_SETTINGS_FILE = userFile;

      const adapter = new AmpMCPAdapter();
      const cmdSpy = vi
        .spyOn(
          adapter as unknown as { commandExists: (cmd: string) => Promise<boolean> },
          "commandExists",
        )
        .mockResolvedValue(false);

      expect(await adapter.detect(cwd)).toBe(false);
      expect(cmdSpy).toHaveBeenCalledWith("amp");

      await writeFile(userFile, "{}\n", "utf-8");
      expect(await adapter.detect(cwd)).toBe(true);

      await rm(userFile);
      await mkdir(join(cwd, ".amp"), { recursive: true });
      await writeFile(join(cwd, ".amp/settings.json"), "{}\n", "utf-8");
      expect(await adapter.detect(cwd)).toBe(true);
    });

    it("uninstall removes only amp.mcpServers when other settings exist", async () => {
      const cwd = await scratch();
      await mkdir(join(cwd, ".amp"), { recursive: true });
      await writeFile(
        join(cwd, ".amp/settings.json"),
        `${JSON.stringify(
          {
            $schema: "https://ampcode.com/schemas/settings.json",
            "amp.permissions": [],
            "amp.mcpServers": { github: { command: "npx" } },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );

      const adapter = new AmpMCPAdapter();
      await adapter.uninstall(cwd);

      const fullPath = join(cwd, ".amp/settings.json");
      expect(existsSync(fullPath)).toBe(true);
      const parsed = JSON.parse(await readFile(fullPath, "utf-8")) as Record<string, unknown>;
      expect(parsed.$schema).toBe("https://ampcode.com/schemas/settings.json");
      expect(parsed["amp.permissions"]).toEqual([]);
      expect(parsed["amp.mcpServers"]).toBeUndefined();
    });

    it("uninstall deletes .amp/settings.json when amp.mcpServers was the only key", async () => {
      const cwd = await scratch();
      const adapter = new AmpMCPAdapter();
      await adapter.install(await adapter.generate([stdioServer]), cwd);

      const fullPath = join(cwd, ".amp/settings.json");
      expect(existsSync(fullPath)).toBe(true);

      await adapter.uninstall(cwd);
      expect(existsSync(fullPath)).toBe(false);
    });

    it("uninstall leaves JSONC settings untouched when amp.mcpServers is absent", async () => {
      const cwd = await scratch();
      await mkdir(join(cwd, ".amp"), { recursive: true });
      const original = `{\n  // User comment preserved\n  "$schema": "https://ampcode.com/schemas/settings.json"\n}\n`;
      await writeFile(join(cwd, ".amp/settings.json"), original, "utf-8");

      const adapter = new AmpMCPAdapter();
      await adapter.uninstall(cwd);

      expect(await readFile(join(cwd, ".amp/settings.json"), "utf-8")).toBe(original);
    });
  });
});
