import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { ClaudeDesktopMCPAdapter, resolveClaudeDesktopConfigPath } from "./claude-desktop.js";
import type { MCPServerDefinition } from "../types/index.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

describe("resolveClaudeDesktopConfigPath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("resolves macOS Application Support path", () => {
    setPlatform("darwin");
    expect(resolveClaudeDesktopConfigPath()).toBe(
      join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    );
  });

  it("resolves Windows path using APPDATA when set", () => {
    setPlatform("win32");
    vi.stubEnv("APPDATA", join("C:", "Users", "tester", "AppData", "Roaming"));
    expect(resolveClaudeDesktopConfigPath()).toBe(
      join("C:", "Users", "tester", "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
    );
  });

  it("resolves Windows path falling back to homedir when APPDATA is unset", () => {
    setPlatform("win32");
    vi.stubEnv("APPDATA", "");
    expect(resolveClaudeDesktopConfigPath()).toBe(
      join(homedir(), "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
    );
  });

  it("resolves Linux path using XDG_CONFIG_HOME when set", () => {
    setPlatform("linux");
    vi.stubEnv("XDG_CONFIG_HOME", "/custom/xdg");
    expect(resolveClaudeDesktopConfigPath()).toBe(
      join("/custom/xdg", "Claude", "claude_desktop_config.json"),
    );
  });

  it("resolves Linux path falling back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    setPlatform("linux");
    vi.stubEnv("XDG_CONFIG_HOME", "");
    expect(resolveClaudeDesktopConfigPath()).toBe(
      join(homedir(), ".config", "Claude", "claude_desktop_config.json"),
    );
  });

  it("returns null on unsupported platforms", () => {
    setPlatform("freebsd");
    expect(resolveClaudeDesktopConfigPath()).toBeNull();
  });
});

describe("ClaudeDesktopMCPAdapter", () => {
  let tempRoot: string;
  let projectDir: string;
  let configPath: string;
  let adapter: ClaudeDesktopMCPAdapter;

  const testServer: MCPServerDefinition = {
    id: "cert-coach",
    name: "Certification Coach",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["cert-coach-mcp"],
      env: { NODE_ENV: "test" },
    },
  };

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "ai-tools-claude-desktop-"));
    projectDir = await mkdtemp(join(tmpdir(), "ai-tools-claude-desktop-cwd-"));
    setPlatform("linux");
    vi.stubEnv("XDG_CONFIG_HOME", tempRoot);
    configPath = join(tempRoot, "Claude", "claude_desktop_config.json");
    adapter = new ClaudeDesktopMCPAdapter();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    await rm(tempRoot, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it("exposes expected metadata, userConfigPath, and user-only scope", () => {
    expect(adapter.id).toBe("claude-desktop");
    expect(adapter.name).toBe("Claude Desktop");
    expect(adapter.nativeSupport).toBe(true);
    expect(adapter.configPath).toBe("claude_desktop_config.json");
    expect(adapter.scope).toBe("user-only");
    expect(adapter.userConfigPath).toBe(configPath);

    setPlatform("freebsd");
    const unsupported = new ClaudeDesktopMCPAdapter();
    expect(unsupported.userConfigPath).toBeUndefined();
  });

  it("generates a Claude Desktop config with stdio entries", async () => {
    const files = await adapter.generate([testServer]);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("claude_desktop_config.json");
    const parsed = JSON.parse(files[0]!.content) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcpServers["cert-coach"]).toEqual({
      type: "stdio",
      command: "npx",
      args: ["cert-coach-mcp"],
      env: { NODE_ENV: "test" },
    });
  });

  it("rejects non-stdio MCP servers during generate", async () => {
    await expect(
      adapter.generate([
        {
          id: "remote-sse",
          name: "Remote SSE",
          transport: { type: "sse", url: "https://example.com/sse" },
        },
      ]),
    ).rejects.toThrow("stdio MCP servers only");

    await expect(
      adapter.generate([
        {
          id: "remote-http",
          name: "Remote HTTP",
          transport: { type: "http", url: "https://example.com/mcp" },
        },
      ]),
    ).rejects.toThrow("stdio MCP servers only");
  });

  it("installs into the resolved OS global config and never writes to cwd", async () => {
    const files = await adapter.generate([testServer]);
    await adapter.install(files);

    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(projectDir, "claude_desktop_config.json"))).toBe(false);

    const parsed = JSON.parse(await readFile(configPath, "utf-8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcpServers["cert-coach"]?.command).toBe("npx");
  });

  it("merges mcpServers during install while preserving globalShortcut, preferences, and existing servers", async () => {
    await mkdir(join(tempRoot, "Claude"), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          globalShortcut: "Ctrl+Space",
          preferences: { quickEntryShortcut: "off", menuBarEnabled: true },
          mcpServers: {
            existing: { command: "node", args: ["server.js"], env: { A: "1" } },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const files = await adapter.generate([testServer]);
    await adapter.install(files);

    const parsed = JSON.parse(await readFile(configPath, "utf-8")) as {
      globalShortcut: string;
      preferences: Record<string, unknown>;
      mcpServers: Record<string, Record<string, unknown>>;
    };

    expect(parsed.globalShortcut).toBe("Ctrl+Space");
    expect(parsed.preferences).toEqual({ quickEntryShortcut: "off", menuBarEnabled: true });
    expect(parsed.mcpServers.existing).toEqual({
      command: "node",
      args: ["server.js"],
      env: { A: "1" },
    });
    expect(parsed.mcpServers["cert-coach"]).toEqual({
      type: "stdio",
      command: "npx",
      args: ["cert-coach-mcp"],
      env: { NODE_ENV: "test" },
    });
  });

  it("throws on install for unsupported platforms", async () => {
    setPlatform("freebsd");
    const files = await adapter.generate([testServer]);
    await expect(adapter.install(files)).rejects.toThrow("macOS, Windows, and Linux");
  });

  it("detects only the resolved OS global config and ignores cwd", async () => {
    await writeFile(
      join(projectDir, "claude_desktop_config.json"),
      JSON.stringify({ mcpServers: {} }),
      "utf-8",
    );

    expect(await adapter.detect()).toBe(false);

    await mkdir(join(tempRoot, "Claude"), { recursive: true });
    await writeFile(configPath, JSON.stringify({ mcpServers: {} }), "utf-8");

    expect(await adapter.detect()).toBe(true);

    setPlatform("freebsd");
    expect(await adapter.detect()).toBe(false);
  });

  it("imports stdio servers via import() and importUser(), filtering out non-stdio and invalid entries", async () => {
    await mkdir(join(tempRoot, "Claude"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        globalShortcut: "Ctrl+Space",
        mcpServers: {
          "cert-coach": {
            type: "stdio",
            command: "npx",
            args: ["cert-coach-mcp"],
            env: { NODE_ENV: "test" },
          },
          "bad-types": {
            command: "node",
            args: [123],
            env: "not-an-object",
          },
          "remote-http": {
            type: "http",
            url: "https://example.com/mcp",
          },
          "remote-sse": {
            url: "https://example.com/sse",
          },
          "null-entry": null,
          "array-entry": ["invalid"],
        },
      }),
      "utf-8",
    );

    const fromImport = await adapter.import();
    const fromImportUser = await adapter.importUser();

    expect(fromImport).toEqual(fromImportUser);
    expect(fromImport).toEqual([
      {
        id: "cert-coach",
        name: "cert-coach",
        transport: {
          type: "stdio",
          command: "npx",
          args: ["cert-coach-mcp"],
          env: { NODE_ENV: "test" },
        },
      },
      {
        id: "bad-types",
        name: "bad-types",
        transport: {
          type: "stdio",
          command: "node",
        },
      },
    ]);
  });

  it("handles malformed JSON and invalid config structures resiliently on import", async () => {
    expect(await adapter.import()).toEqual([]);

    await mkdir(join(tempRoot, "Claude"), { recursive: true });

    for (const badPayload of [
      "{ not valid json",
      "null",
      "[]",
      '"string"',
      JSON.stringify({ mcpServers: null }),
      JSON.stringify({ mcpServers: [] }),
      JSON.stringify({ mcpServers: "invalid" }),
    ]) {
      await writeFile(configPath, badPayload, "utf-8");
      expect(await adapter.import()).toEqual([]);
      expect(await adapter.importUser()).toEqual([]);
    }
  });

  it("non-destructively removes only mcpServers during uninstall without touching preferences or cwd", async () => {
    const cwdConfig = join(projectDir, "claude_desktop_config.json");
    await writeFile(cwdConfig, JSON.stringify({ mcpServers: { local: { command: "echo" } } }));

    await mkdir(join(tempRoot, "Claude"), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          globalShortcut: "Ctrl+Space",
          preferences: { menuBarEnabled: true },
          mcpServers: {
            "cert-coach": { type: "stdio", command: "npx", args: ["cert-coach-mcp"], env: {} },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await adapter.uninstall();

    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(cwdConfig)).toBe(true);

    const parsed = JSON.parse(await readFile(configPath, "utf-8")) as Record<string, unknown>;
    expect(parsed).toEqual({
      globalShortcut: "Ctrl+Space",
      preferences: { menuBarEnabled: true },
    });
    expect("mcpServers" in parsed).toBe(false);
    expect(await adapter.import()).toEqual([]);
  });

  it("handles uninstall gracefully when config is missing, lacks mcpServers, or has malformed JSON", async () => {
    await expect(adapter.uninstall()).resolves.toBeUndefined();

    await mkdir(join(tempRoot, "Claude"), { recursive: true });
    const original = JSON.stringify({ globalShortcut: "Ctrl+Space" });
    await writeFile(configPath, original, "utf-8");
    await adapter.uninstall();
    expect(await readFile(configPath, "utf-8")).toBe(original);

    await writeFile(configPath, "{ malformed", "utf-8");
    await expect(adapter.uninstall()).resolves.toBeUndefined();
    expect(await readFile(configPath, "utf-8")).toBe("{ malformed");
  });
});
