import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { OpenCodeMCPAdapter, stripJsonc } from "./opencode.js";
import type { MCPServerDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-mcp-opencode-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("OpenCodeMCPAdapter", () => {
  let adapter: OpenCodeMCPAdapter;
  const origOpenCodeConfig = process.env.OPENCODE_CONFIG;
  const origXdgConfigHome = process.env.XDG_CONFIG_HOME;

  const testServer: MCPServerDefinition = {
    id: "test-server",
    name: "Test Server",
    transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { KEY: "val" } },
  };

  beforeEach(() => {
    delete process.env.OPENCODE_CONFIG;
    delete process.env.XDG_CONFIG_HOME;
    adapter = new OpenCodeMCPAdapter();
  });

  afterEach(() => {
    if (origOpenCodeConfig !== undefined) process.env.OPENCODE_CONFIG = origOpenCodeConfig;
    else delete process.env.OPENCODE_CONFIG;
    if (origXdgConfigHome !== undefined) process.env.XDG_CONFIG_HOME = origXdgConfigHome;
    else delete process.env.XDG_CONFIG_HOME;
  });

  describe("metadata & userConfigPath", () => {
    it("has correct metadata", () => {
      expect(adapter.id).toBe("opencode");
      expect(adapter.name).toBe("OpenCode");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configPath).toBe("opencode.json");
    });

    it("resolves userConfigPath using OPENCODE_CONFIG, XDG_CONFIG_HOME, or default", () => {
      expect(adapter.userConfigPath).toBe(join(homedir(), ".config", "opencode", "opencode.json"));

      process.env.XDG_CONFIG_HOME = join(tmpdir(), "xdg-cfg");
      expect(adapter.userConfigPath).toBe(join(tmpdir(), "xdg-cfg", "opencode", "opencode.json"));

      process.env.OPENCODE_CONFIG = join(tmpdir(), "custom-opencode.jsonc");
      expect(adapter.userConfigPath).toBe(resolve(join(tmpdir(), "custom-opencode.jsonc")));
    });
  });

  describe("stripJsonc", () => {
    it("strips line comments, block comments, and trailing commas while preserving URLs in strings", () => {
      const input = `{
        // line comment
        "mcp": {
          /* block comment */
          "remote": {
            "type": "remote",
            "url": "https://mcp.example.com//v1",
          },
        },
      }`;
      const parsed = JSON.parse(stripJsonc(input)) as { mcp: { remote: { url: string } } };
      expect(parsed.mcp.remote.url).toBe("https://mcp.example.com//v1");
    });
  });

  describe("generate", () => {
    it("generates native OpenCode mcp entries with env when provided", async () => {
      const files = await adapter.generate([testServer]);
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe("opencode.json");
      const parsed = JSON.parse(files[0]!.content) as {
        mcp: Record<
          string,
          { type: string; command: string[]; environment?: Record<string, string> }
        >;
      };
      expect(parsed.mcp["test-server"]).toEqual({
        type: "local",
        command: ["npx", "-y", "test-mcp"],
        enabled: true,
        environment: { KEY: "val" },
      });
    });

    it("omits empty environment object on stdio servers", async () => {
      const server: MCPServerDefinition = {
        id: "minimal",
        name: "Minimal",
        transport: { type: "stdio", command: "node", env: {} },
      };
      const files = await adapter.generate([server]);
      const parsed = JSON.parse(files[0]!.content) as {
        mcp: Record<string, Record<string, unknown>>;
      };
      expect(parsed.mcp.minimal).toEqual({
        type: "local",
        command: ["node"],
        enabled: true,
      });
      expect("environment" in parsed.mcp.minimal!).toBe(false);
    });

    it("emits remote entries with headers", async () => {
      const httpServer: MCPServerDefinition = {
        id: "linear",
        name: "linear",
        transport: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer token" },
        },
      };
      const files = await adapter.generate([httpServer]);
      const parsed = JSON.parse(files[0]!.content) as {
        mcp: Record<string, { type: string; url: string; headers?: Record<string, string> }>;
      };
      expect(parsed.mcp.linear).toMatchObject({
        type: "remote",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer token" },
      });
    });
  });

  describe("import, importUser, install, uninstall, and detect", () => {
    it("reads project opencode.jsonc with comments and trailing commas", async () => {
      await withTempDir(async (dir) => {
        await writeFile(
          join(dir, "opencode.jsonc"),
          `{
            // OpenCode MCP servers
            "mcp": {
              "local-srv": {
                "type": "local",
                "command": ["npx", "-y", "test-mcp"],
                "environment": { "A": "1", },
              },
              "remote-srv": {
                "type": "remote",
                "url": "https://mcp.example.com/sse",
                "headers": { "X-Key": "secret", },
              },
            },
          }\n`,
        );

        const servers = await adapter.import(dir);
        expect(servers).toHaveLength(2);
        expect(servers[0]).toMatchObject({
          id: "local-srv",
          transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"], env: { A: "1" } },
        });
        expect(servers[1]).toMatchObject({
          id: "remote-srv",
          transport: {
            type: "http",
            url: "https://mcp.example.com/sse",
            headers: { "X-Key": "secret" },
          },
        });
      });
    });

    it("reads user config from XDG_CONFIG_HOME/opencode/opencode.jsonc and OPENCODE_CONFIG", async () => {
      await withTempDir(async (dir) => {
        const xdgDir = join(dir, "xdg");
        await mkdir(join(xdgDir, "opencode"), { recursive: true });
        await writeFile(
          join(xdgDir, "opencode", "opencode.jsonc"),
          `{ /* user */ "mcp": { "u1": { "type": "remote", "url": "https://u1.dev", }, }, }`,
        );
        process.env.XDG_CONFIG_HOME = xdgDir;

        const fromXdg = await adapter.importUser();
        expect(fromXdg).toHaveLength(1);
        expect(fromXdg[0]!.id).toBe("u1");

        const explicitPath = join(dir, "explicit.jsonc");
        await writeFile(
          explicitPath,
          `{ "mcp": { "u2": { "type": "local", "command": ["node", "srv.js"] } } }`,
        );
        process.env.OPENCODE_CONFIG = explicitPath;

        const fromExplicit = await adapter.importUser();
        expect(fromExplicit).toHaveLength(1);
        expect(fromExplicit[0]!.id).toBe("u2");
      });
    });

    it("merges on install and strips only mcp on uninstall (preserving other keys)", async () => {
      await withTempDir(async (dir) => {
        const configPath = join(dir, "opencode.json");
        await writeFile(
          configPath,
          JSON.stringify(
            { model: "anthropic/claude-sonnet-4", instructions: [".opencode/instructions/*.md"] },
            null,
            2,
          ),
        );

        const files = await adapter.generate([testServer]);
        await adapter.install(files, dir);

        const installed = JSON.parse(await readFile(configPath, "utf-8")) as Record<
          string,
          unknown
        >;
        expect(installed.model).toBe("anthropic/claude-sonnet-4");
        expect(installed.mcp).toBeDefined();

        await adapter.uninstall(dir);
        expect(existsSync(configPath)).toBe(true);
        const afterUninstall = JSON.parse(await readFile(configPath, "utf-8")) as Record<
          string,
          unknown
        >;
        expect(afterUninstall.model).toBe("anthropic/claude-sonnet-4");
        expect(afterUninstall.mcp).toBeUndefined();
      });
    });

    it("deletes opencode.json on uninstall when mcp was the only key", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testServer]);
        await adapter.install(files, dir);
        expect(existsSync(join(dir, "opencode.json"))).toBe(true);

        await adapter.uninstall(dir);
        expect(existsSync(join(dir, "opencode.json"))).toBe(false);
      });
    });

    it("detects opencode.jsonc and .opencode in project dir", async () => {
      await withTempDir(async (dir) => {
        const cmdSpy = vi
          .spyOn(adapter as unknown as { commandExists: () => Promise<boolean> }, "commandExists")
          .mockResolvedValue(false);
        try {
          expect(await adapter.detect(dir)).toBe(false);
          await writeFile(join(dir, "opencode.jsonc"), "{}\n");
          expect(await adapter.detect(dir)).toBe(true);
        } finally {
          cmdSpy.mockRestore();
        }
      });
    });
  });
});
