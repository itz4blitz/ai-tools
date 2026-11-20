import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeMCPAdapter } from "./claude-code.js";
import { CodexMCPAdapter } from "./codex.js";
import { CursorMCPAdapter } from "./cursor.js";
import { GrokMCPAdapter } from "./grok.js";
import { OpenCodeMCPAdapter } from "./opencode.js";
import { ZcodeMCPAdapter } from "./zcode.js";
import type { MCPServerDefinition } from "../types/index.js";

const stdio: MCPServerDefinition = {
  id: "github",
  name: "github",
  transport: {
    type: "stdio",
    command: "/usr/local/bin/gh-mcp",
    args: ["--verbose"],
    env: { TOKEN: "secret" },
  },
};

const http: MCPServerDefinition = {
  id: "linear",
  name: "linear",
  transport: {
    type: "http",
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: "Bearer token" },
  },
};

const sse: MCPServerDefinition = {
  id: "events",
  name: "events",
  transport: {
    type: "sse",
    url: "http://localhost:3000/sse",
  },
};

describe("MCP adapter filesystem round-trips", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ai-tools-mcp-"));
    dirs.push(dir);
    return dir;
  }

  describe("Cursor .cursor/mcp.json", () => {
    it("writes mcpServers with type http/sse and round-trips them", async () => {
      const cwd = await scratch();
      const adapter = new CursorMCPAdapter();
      await adapter.install(await adapter.generate([stdio, http, sse]), cwd);
      const parsed = JSON.parse(await readFile(join(cwd, ".cursor/mcp.json"), "utf-8")) as {
        mcpServers: Record<string, Record<string, unknown>>;
      };
      expect(parsed.mcpServers.github).toMatchObject({
        command: "/usr/local/bin/gh-mcp",
        args: ["--verbose"],
        env: { TOKEN: "secret" },
      });
      expect(parsed.mcpServers.linear).toEqual({
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer token" },
      });
      expect(parsed.mcpServers.events).toMatchObject({
        type: "sse",
        url: "http://localhost:3000/sse",
      });
      const imported = await adapter.import(cwd);
      expect(imported.find((s) => s.id === "linear")?.transport).toEqual(http.transport);
      expect(imported.find((s) => s.id === "events")?.transport.type).toBe("sse");
      expect(imported.find((s) => s.id === "github")?.transport).toMatchObject({
        type: "stdio",
        command: "/usr/local/bin/gh-mcp",
        args: ["--verbose"],
        env: { TOKEN: "secret" },
      });
    });

    it("imports host files that omit type", async () => {
      const cwd = await scratch();
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(
        join(cwd, ".cursor/mcp.json"),
        `${JSON.stringify({
          mcpServers: {
            github: { command: "gh-mcp", args: [] },
            hosted: { url: "https://mcp.example.com/sse" },
          },
        })}\n`,
        "utf-8",
      );
      const imported = await new CursorMCPAdapter().import(cwd);
      expect(imported.find((s) => s.id === "github")?.transport.type).toBe("stdio");
      expect(imported.find((s) => s.id === "hosted")?.transport).toMatchObject({
        type: "sse",
        url: "https://mcp.example.com/sse",
      });
    });
  });

  describe("Claude Code .mcp.json / ~/.claude.json", () => {
    it("writes project .mcp.json mcpServers and round-trips type", async () => {
      const cwd = await scratch();
      const adapter = new ClaudeCodeMCPAdapter();
      expect(adapter.configPath).toBe(".mcp.json");
      expect(adapter.userConfigPath).toMatch(/\.claude\.json$/);
      await adapter.install(await adapter.generate([stdio, http, sse]), cwd);
      const parsed = JSON.parse(await readFile(join(cwd, ".mcp.json"), "utf-8")) as {
        mcpServers: Record<string, Record<string, unknown>>;
      };
      expect(parsed.mcpServers.linear).toMatchObject({
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer token" },
      });
      expect(parsed.mcpServers.events).toMatchObject({
        type: "sse",
        url: "http://localhost:3000/sse",
      });
      const imported = await adapter.import(cwd);
      expect(imported.find((s) => s.id === "linear")?.transport.type).toBe("http");
      expect(imported.find((s) => s.id === "events")?.transport.type).toBe("sse");
    });

    it("merges mcpServers into existing user settings without clobbering other keys", async () => {
      const cwd = await scratch();
      const userFile = join(cwd, ".claude.json");
      await writeFile(
        userFile,
        `${JSON.stringify(
          {
            theme: "dark",
            numStartups: 9,
            mcpServers: { keep: { command: "keep-me" } },
          },
          null,
          2,
        )}\n`,
        "utf-8",
      );
      const adapter = new ClaudeCodeMCPAdapter();
      const files = await adapter.generate([http]);
      files[0]!.path = userFile;
      await adapter.install(files, cwd);
      const parsed = JSON.parse(await readFile(userFile, "utf-8")) as {
        theme: string;
        numStartups: number;
        mcpServers: Record<string, Record<string, unknown>>;
      };
      expect(parsed.theme).toBe("dark");
      expect(parsed.numStartups).toBe(9);
      expect(parsed.mcpServers.keep).toEqual({ command: "keep-me" });
      expect(parsed.mcpServers.linear).toMatchObject({
        type: "http",
        url: "https://mcp.linear.app/mcp",
      });
    });

    it("imports project files that omit type", async () => {
      const cwd = await scratch();
      await writeFile(
        join(cwd, ".mcp.json"),
        `${JSON.stringify({
          mcpServers: { hosted: { url: "https://mcp.example.com/mcp" } },
        })}\n`,
        "utf-8",
      );
      const imported = await new ClaudeCodeMCPAdapter().import(cwd);
      expect(imported[0]?.transport).toMatchObject({
        type: "sse",
        url: "https://mcp.example.com/mcp",
      });
    });
  });

  describe("ZCode .zcode/config.json mcp.servers", () => {
    it("writes { mcp: { servers } } and never a fake mcp.json", async () => {
      const cwd = await scratch();
      const adapter = new ZcodeMCPAdapter();
      expect(adapter.configPath).toBe(".zcode/config.json");
      await adapter.install(await adapter.generate([stdio, http, sse]), cwd);
      const raw = await readFile(join(cwd, ".zcode/config.json"), "utf-8");
      expect(raw).not.toContain("mcpServers");
      const parsed = JSON.parse(raw) as {
        mcp: { servers: Record<string, Record<string, unknown>> };
      };
      expect(parsed.mcp.servers.github).toMatchObject({
        type: "stdio",
        command: "/usr/local/bin/gh-mcp",
        args: ["--verbose"],
        env: { TOKEN: "secret" },
      });
      expect(parsed.mcp.servers.linear).toEqual({
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer token" },
      });
      expect(parsed.mcp.servers.events).toMatchObject({
        type: "sse",
        url: "http://localhost:3000/sse",
      });
      const imported = await adapter.import(cwd);
      expect(imported.find((s) => s.id === "linear")?.transport).toEqual(http.transport);
      expect(imported.find((s) => s.id === "events")?.transport.type).toBe("sse");
    });

    it("merges mcp.servers into existing config without clobbering other keys", async () => {
      const cwd = await scratch();
      const userFile = join(cwd, "cli-config.json");
      await writeFile(
        userFile,
        `${JSON.stringify({ model: "keep-me", mcp: { servers: { keep: { type: "stdio", command: "old" } } } })}\n`,
        "utf-8",
      );
      const adapter = new ZcodeMCPAdapter();
      const files = await adapter.generate([stdio]);
      files[0]!.path = userFile;
      await adapter.install(files, cwd);
      const parsed = JSON.parse(await readFile(userFile, "utf-8")) as {
        model: string;
        mcp: { servers: Record<string, { command?: string; type?: string }> };
      };
      expect(parsed.model).toBe("keep-me");
      expect(parsed.mcp.servers.keep?.command).toBe("old");
      expect(parsed.mcp.servers.github?.type).toBe("stdio");
      expect(parsed.mcp.servers.github?.command).toBe("/usr/local/bin/gh-mcp");
    });

    it("imports host files that omit type", async () => {
      const cwd = await scratch();
      await mkdir(join(cwd, ".zcode"), { recursive: true });
      await writeFile(
        join(cwd, ".zcode/config.json"),
        `${JSON.stringify({
          mcp: {
            servers: {
              github: { command: "gh-mcp", args: [] },
              hosted: { url: "https://mcp.example.com/mcp" },
            },
          },
        })}\n`,
        "utf-8",
      );
      const imported = await new ZcodeMCPAdapter().import(cwd);
      expect(imported.find((s) => s.id === "github")?.transport.type).toBe("stdio");
      expect(imported.find((s) => s.id === "hosted")?.transport).toMatchObject({
        type: "http",
        url: "https://mcp.example.com/mcp",
      });
    });
  });

  describe("Grok TOML ~/.grok/config.toml [mcp_servers]", () => {
    it("writes TOML that preserves command/args/env/url", async () => {
      const cwd = await scratch();
      const adapter = new GrokMCPAdapter();
      await adapter.install(await adapter.generate([stdio, http]), cwd);
      const raw = await readFile(join(cwd, ".grok/config.toml"), "utf-8");
      expect(raw).toContain("[mcp_servers.github]");
      expect(raw).toContain('command = "/usr/local/bin/gh-mcp"');
      expect(raw).toContain('args = ["--verbose"]');
      expect(raw).toContain("[mcp_servers.github.env]");
      expect(raw).toContain('TOKEN = "secret"');
      expect(raw).toContain("[mcp_servers.linear]");
      expect(raw).toContain('url = "https://mcp.linear.app/mcp"');
      expect(raw).not.toContain("mcpServers");
      const imported = await adapter.import(cwd);
      expect(imported.find((s) => s.id === "github")?.transport).toEqual(stdio.transport);
      expect(imported.find((s) => s.id === "linear")?.transport).toMatchObject({
        type: "http",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer token" },
      });
    });

    it("Grok merge keeps unrelated tables", async () => {
      const cwd = await scratch();
      const adapter = new GrokMCPAdapter();
      await mkdir(join(cwd, ".grok"), { recursive: true });
      await writeFile(join(cwd, ".grok/config.toml"), "[ui]\nyolo = true\n", "utf-8");
      await adapter.install(await adapter.generate([stdio]), cwd);
      const raw = await readFile(join(cwd, ".grok/config.toml"), "utf-8");
      expect(raw).toContain("[ui]");
      expect(raw).toContain("yolo = true");
      expect(raw).toContain("[mcp_servers.github]");
    });
  });

  describe("Codex TOML ~/.codex/config.toml [mcp_servers]", () => {
    it("writes native TOML not JSON and round-trips command/args/env/url", async () => {
      const cwd = await scratch();
      const adapter = new CodexMCPAdapter();
      await adapter.install(await adapter.generate([stdio, http]), cwd);
      const raw = await readFile(join(cwd, ".codex/config.toml"), "utf-8");
      expect(raw.startsWith("{")).toBe(false);
      expect(raw).toContain("[mcp_servers.github]");
      expect(raw).toContain('command = "/usr/local/bin/gh-mcp"');
      expect(raw).toContain('args = ["--verbose"]');
      expect(raw).toContain("[mcp_servers.github.env]");
      expect(raw).toContain('TOKEN = "secret"');
      expect(raw).toContain('url = "https://mcp.linear.app/mcp"');
      const imported = await adapter.import(cwd);
      expect(imported.find((s) => s.id === "github")?.transport).toEqual(stdio.transport);
      expect(imported.find((s) => s.id === "linear")?.transport).toMatchObject({
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer token" },
      });
    });

    it("merges into existing Codex config without dropping model", async () => {
      const cwd = await scratch();
      const adapter = new CodexMCPAdapter();
      await mkdir(join(cwd, ".codex"), { recursive: true });
      await writeFile(join(cwd, ".codex/config.toml"), 'model = "gpt-5"\n', "utf-8");
      await adapter.install(await adapter.generate([stdio, http]), cwd);
      const raw = await readFile(join(cwd, ".codex/config.toml"), "utf-8");
      expect(raw).toContain('model = "gpt-5"');
      expect(raw).toContain("[mcp_servers.github]");
      expect(raw).toContain("[mcp_servers.linear.http_headers]");
      expect(raw).toContain('url = "https://mcp.linear.app/mcp"');
    });
  });

  describe("OpenCode opencode.json mcp local/remote", () => {
    it("writes mcp local command arrays and remote url+headers", async () => {
      const cwd = await scratch();
      const adapter = new OpenCodeMCPAdapter();
      await adapter.install(await adapter.generate([stdio, http]), cwd);
      const parsed = JSON.parse(await readFile(join(cwd, "opencode.json"), "utf-8")) as {
        mcp: Record<string, Record<string, unknown>>;
      };
      expect(parsed.mcp.github).toMatchObject({
        type: "local",
        command: ["/usr/local/bin/gh-mcp", "--verbose"],
        environment: { TOKEN: "secret" },
      });
      expect(parsed.mcp.linear).toMatchObject({
        type: "remote",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer token" },
      });
      const imported = await adapter.import(cwd);
      expect(imported.find((s) => s.id === "github")?.transport).toMatchObject({
        type: "stdio",
        command: "/usr/local/bin/gh-mcp",
        args: ["--verbose"],
        env: { TOKEN: "secret" },
      });
      expect(imported.find((s) => s.id === "linear")?.transport).toEqual(http.transport);
    });

    it("merges mcp into existing opencode.json without clobbering model", async () => {
      const cwd = await scratch();
      const adapter = new OpenCodeMCPAdapter();
      await writeFile(
        join(cwd, "opencode.json"),
        `${JSON.stringify({ model: "keep-me", mcp: { keep: { type: "local", command: ["old"] } } })}\n`,
        "utf-8",
      );
      await adapter.install(await adapter.generate([stdio]), cwd);
      const parsed = JSON.parse(await readFile(join(cwd, "opencode.json"), "utf-8")) as {
        model: string;
        mcp: Record<string, { type?: string; command?: string[] }>;
      };
      expect(parsed.model).toBe("keep-me");
      expect(parsed.mcp.keep?.command).toEqual(["old"]);
      expect(parsed.mcp.github?.type).toBe("local");
    });

    it("imports host files that omit type", async () => {
      const cwd = await scratch();
      await writeFile(
        join(cwd, "opencode.json"),
        `${JSON.stringify({
          mcp: {
            github: { command: ["gh-mcp"] },
            hosted: { url: "https://mcp.example.com/mcp" },
          },
        })}\n`,
        "utf-8",
      );
      const imported = await new OpenCodeMCPAdapter().import(cwd);
      expect(imported.find((s) => s.id === "github")?.transport.type).toBe("stdio");
      expect(imported.find((s) => s.id === "hosted")?.transport).toMatchObject({
        type: "http",
        url: "https://mcp.example.com/mcp",
      });
    });
  });
});
