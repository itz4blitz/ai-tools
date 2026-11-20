import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MCPServerDefinition } from "../types/index.js";

const { mockHome } = vi.hoisted(() => ({ mockHome: { value: "" } }));

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => mockHome.value || actual.homedir(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (error: Error | null) => void) => {
    cb(new Error("not found"));
  }),
}));

import { execFile } from "node:child_process";
import { ZcodeMCPAdapter } from "./zcode.js";

describe("ZcodeMCPAdapter", () => {
  let adapter: ZcodeMCPAdapter;
  let tmp: string;
  let home: string;

  const stdio: MCPServerDefinition = {
    id: "github",
    name: "github",
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "zcode-mcp-"));
    home = await mkdtemp(join(tmpdir(), "zcode-mcp-home-"));
    mockHome.value = home;
    adapter = new ZcodeMCPAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("uses cross-platform ZCode user and project paths", () => {
    expect(adapter.id).toBe("zcode");
    expect(adapter.name).toBe("ZCode");
    expect(adapter.configPath).toBe(".zcode/config.json");
    expect(adapter.userConfigPath).toBe(join(home, ".zcode", "cli", "config.json"));
    expect(adapter.command).toBe("zcode");
  });

  it("detects ZCode from user config, ~/.zcode, project .zcode, or zcode binary", async () => {
    expect(await adapter.detect(tmp)).toBe(false);

    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(join(home, ".zcode", "cli", "config.json"), "{}\n", "utf-8");
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(home, ".zcode"), { recursive: true, force: true });
    expect(await adapter.detect(tmp)).toBe(false);

    await mkdir(join(tmp, ".zcode"), { recursive: true });
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(tmp, ".zcode"), { recursive: true, force: true });
    vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof execFile);
    expect(await adapter.detect(tmp)).toBe(true);
  });

  it("generates project { mcp: { servers } } JSON, not mcpServers", async () => {
    const files = await adapter.generate([stdio]);
    expect(files[0]?.path).toBe(".zcode/config.json");
    const parsed = JSON.parse(files[0]!.content) as {
      mcp: { servers: Record<string, { command: string; type: string; args: string[] }> };
    };
    expect(parsed.mcp.servers.github).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
    });
    expect(files[0]!.content).not.toContain("mcpServers");
  });

  it("emits type http/sse for remotes", async () => {
    const files = await adapter.generate([
      {
        id: "linear",
        name: "linear",
        transport: {
          type: "http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: "Bearer token" },
        },
      },
      {
        id: "events",
        name: "events",
        transport: { type: "sse", url: "http://localhost:3000/sse" },
      },
    ]);
    const parsed = JSON.parse(files[0]!.content) as {
      mcp: { servers: Record<string, Record<string, unknown>> };
    };
    expect(parsed.mcp.servers.linear).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer token" },
    });
    expect(parsed.mcp.servers.events).toEqual({
      type: "sse",
      url: "http://localhost:3000/sse",
    });
  });

  it("imports user mcp.servers without clobbering other config keys", async () => {
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(
      join(home, ".zcode", "cli", "config.json"),
      JSON.stringify({
        model: "keep-me",
        mcp: {
          servers: {
            acme: {
              type: "stdio",
              command: "acme-mcp",
              args: ["--stdio"],
              env: { ACME_ENV: "dev" },
            },
          },
        },
      }),
      "utf-8",
    );

    const servers = await adapter.importUser();
    expect(servers).toEqual([
      {
        id: "acme",
        name: "acme",
        transport: {
          type: "stdio",
          command: "acme-mcp",
          args: ["--stdio"],
          env: { ACME_ENV: "dev" },
        },
      },
    ]);
  });

  it("merges generated servers into existing config.json without dropping hooks or model", async () => {
    await mkdir(join(tmp, ".zcode"), { recursive: true });
    await writeFile(
      join(tmp, ".zcode", "config.json"),
      JSON.stringify({
        model: "keep-me",
        hooks: { enabled: true, events: {} },
        mcp: {
          servers: {
            existing: { type: "http", url: "https://existing.example.com/mcp" },
          },
        },
      }),
      "utf-8",
    );

    const files = await adapter.generate([stdio]);
    await adapter.install(files, tmp);

    const written = JSON.parse(await readFile(join(tmp, ".zcode", "config.json"), "utf-8")) as {
      model: string;
      hooks: { enabled: boolean };
      mcp: { servers: Record<string, { command?: string; url?: string }> };
    };
    expect(written.model).toBe("keep-me");
    expect(written.hooks.enabled).toBe(true);
    expect(written.mcp.servers.existing?.url).toBe("https://existing.example.com/mcp");
    expect(written.mcp.servers.github?.command).toBe("npx");
  });

  it("guards against malformed JSON and null/non-object server entries", async () => {
    await mkdir(join(tmp, ".zcode"), { recursive: true });
    await writeFile(join(tmp, ".zcode", "config.json"), "{broken-json", "utf-8");
    expect(await adapter.import(tmp)).toEqual([]);

    await writeFile(join(tmp, ".zcode", "config.json"), "[1, 2, 3]", "utf-8");
    expect(await adapter.import(tmp)).toEqual([]);

    await writeFile(
      join(tmp, ".zcode", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            nullEntry: null,
            arrayEntry: ["bad"],
            primitiveEntry: "bad",
            emptyEntry: {},
            validEntry: {
              type: "stdio",
              command: "node",
              args: ["server.js", 123],
              env: { OK: "1", BAD: 2 },
            },
          },
        },
      }),
      "utf-8",
    );
    expect(await adapter.import(tmp)).toEqual([
      {
        id: "validEntry",
        name: "validEntry",
        transport: {
          type: "stdio",
          command: "node",
          args: ["server.js"],
          env: { OK: "1" },
        },
      },
    ]);
  });

  it("strips only mcp.servers on uninstall, preserving hooks/model and deleting only if empty", async () => {
    await mkdir(join(tmp, ".zcode"), { recursive: true });
    const configPath = join(tmp, ".zcode", "config.json");

    // Case 1: preserves sibling keys (model, hooks, other mcp settings)
    await writeFile(
      configPath,
      JSON.stringify({
        model: "keep-me",
        hooks: { enabled: true, events: {} },
        mcp: {
          timeoutMs: 5000,
          servers: {
            github: { type: "stdio", command: "npx", args: [] },
          },
        },
      }),
      "utf-8",
    );
    await adapter.uninstall(tmp);
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({
      model: "keep-me",
      hooks: { enabled: true, events: {} },
      mcp: { timeoutMs: 5000 },
    });

    // Case 2: removes empty mcp block while preserving model
    await writeFile(
      configPath,
      JSON.stringify({
        model: "keep-me",
        mcp: {
          servers: {
            github: { type: "stdio", command: "npx", args: [] },
          },
        },
      }),
      "utf-8",
    );
    await adapter.uninstall(tmp);
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toEqual({
      model: "keep-me",
    });

    // Case 3: deletes config.json when mcp.servers was the only content
    await rm(configPath, { force: true });
    await adapter.install(await adapter.generate([stdio]), tmp);
    expect(existsSync(configPath)).toBe(true);
    await adapter.uninstall(tmp);
    expect(existsSync(configPath)).toBe(false);
  });
});
