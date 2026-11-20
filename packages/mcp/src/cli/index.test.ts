import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BaseMCPAdapter } from "../adapters/base.js";
import type { MCPServerDefinition, GeneratedFile } from "../types/index.js";

const {
  mockRegistryDetectAll,
  mockRegistryList,
  mockRegistryGet,
  mockRegistryGetAll,
  mockWriteFile,
  mockMkdir,
} = vi.hoisted(() => ({
  mockRegistryDetectAll: vi.fn(),
  mockRegistryList: vi.fn(),
  mockRegistryGet: vi.fn(),
  mockRegistryGetAll: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
}));

vi.mock("../adapters/all.js", () => ({}));

vi.mock("../adapters/registry.js", () => ({
  registry: {
    detectAll: (...args: unknown[]) => mockRegistryDetectAll(...args),
    list: () => mockRegistryList(),
    get: (id: string) => mockRegistryGet(id),
    getAll: () => mockRegistryGetAll(),
  },
}));

vi.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  mkdir: (...args: unknown[]) => mockMkdir(...args),
}));

import { run } from "./index.js";

function makeAdapter(overrides: Partial<BaseMCPAdapter> = {}): BaseMCPAdapter {
  return {
    id: overrides.id ?? "test-tool",
    name: overrides.name ?? "Test Tool",
    nativeSupport: overrides.nativeSupport ?? true,
    configPath: overrides.configPath ?? ".test/mcp.json",
    generate:
      overrides.generate ??
      vi
        .fn<(servers: MCPServerDefinition[]) => Promise<GeneratedFile[]>>()
        .mockResolvedValue([{ path: ".test/mcp.json", content: "{}", format: "json" }]),
    import:
      overrides.import ??
      vi.fn<(cwd?: string) => Promise<MCPServerDefinition[]>>().mockResolvedValue([]),
    detect: overrides.detect ?? vi.fn<(cwd?: string) => Promise<boolean>>().mockResolvedValue(true),
    install:
      overrides.install ??
      vi.fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>().mockResolvedValue(undefined),
    uninstall:
      overrides.uninstall ?? vi.fn<(cwd?: string) => Promise<void>>().mockResolvedValue(undefined),
    importUser:
      overrides.importUser ?? vi.fn<() => Promise<MCPServerDefinition[]>>().mockResolvedValue([]),
    userConfigPath: overrides.userConfigPath,
  } as unknown as BaseMCPAdapter;
}

function stdioServer(id: string, extra: Partial<MCPServerDefinition> = {}): MCPServerDefinition {
  return {
    id,
    name: extra.name ?? id,
    transport: extra.transport ?? { type: "stdio", command: "npx", args: ["-y", id] },
    ...extra,
  };
}

function encodedMcpContent(servers: MCPServerDefinition[]): string {
  return JSON.stringify(
    {
      mcpServers: Object.fromEntries(
        servers.map((server) => [
          server.id,
          {
            command: server.transport.type === "stdio" ? server.transport.command : "url",
          },
        ]),
      ),
    },
    null,
    2,
  );
}

function encodeGenerate(
  path: string,
): ReturnType<typeof vi.fn<(servers: MCPServerDefinition[]) => Promise<GeneratedFile[]>>> {
  return vi
    .fn<(servers: MCPServerDefinition[]) => Promise<GeneratedFile[]>>()
    .mockImplementation(async (servers) => [
      { path, content: encodedMcpContent(servers), format: "json" },
    ]);
}

async function withConfig(
  servers: MCPServerDefinition[],
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ai-mcp-cli-"));
  const configPath = join(dir, "mcp.config.mjs");
  writeFileSync(configPath, `export default ${JSON.stringify({ servers }, null, 2)};\n`, "utf-8");
  try {
    await fn(configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let logOutput: string[];
let errorOutput: string[];
let warnOutput: string[];
let exitCode: number | undefined;

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalExit = process.exit;

beforeEach(() => {
  logOutput = [];
  errorOutput = [];
  warnOutput = [];
  exitCode = undefined;

  console.log = vi.fn((...args: unknown[]) => {
    logOutput.push(args.map(String).join(" "));
  });
  console.error = vi.fn((...args: unknown[]) => {
    errorOutput.push(args.map(String).join(" "));
  });
  console.warn = vi.fn((...args: unknown[]) => {
    warnOutput.push(args.map(String).join(" "));
  });
  process.exit = vi.fn((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as never;

  vi.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
  process.exit = originalExit;
});

function allLog(): string {
  return logOutput.join("\n");
}

function allError(): string {
  return errorOutput.join("\n");
}

function allWarn(): string {
  return warnOutput.join("\n");
}

describe("run() - help output", () => {
  it('prints help text for "help" command', async () => {
    await run(["help"]);
    expect(allLog()).toContain("ai-mcp - Universal MCP server configuration");
    expect(allLog()).toContain("USAGE:");
    expect(allLog()).toContain("COMMANDS:");
    expect(allLog()).toContain("OPTIONS:");
    expect(allLog()).toContain("EXAMPLES:");
  });

  it("prints help text for --help flag", async () => {
    await run(["--help"]);
    expect(allLog()).toContain("ai-mcp - Universal MCP server configuration");
  });

  it("prints help text for -h flag", async () => {
    await run(["-h"]);
    expect(allLog()).toContain("ai-mcp - Universal MCP server configuration");
  });

  it("prints help text when no arguments are provided", async () => {
    await run([]);
    expect(allLog()).toContain("ai-mcp - Universal MCP server configuration");
  });

  it("includes all documented commands in help text", async () => {
    await run(["help"]);
    const output = allLog();
    for (const cmd of [
      "init",
      "detect",
      "generate",
      "install",
      "import",
      "sync",
      "export",
      "audit",
      "help",
    ]) {
      expect(output).toContain(cmd);
    }
  });

  it("describes sync as config-scoped and never copying imports", async () => {
    await run(["help"]);
    const output = allLog();
    expect(output).toContain("never copies imports");
    expect(output).toContain("--layer");
    expect(output).toContain("user or project");
    expect(output).not.toContain("union");
    expect(output).not.toMatch(/sync[^\n]*across/i);
  });
});

describe("run() - unknown command", () => {
  it("prints error and help, then exits with code 1", async () => {
    await expect(run(["foobar"])).rejects.toThrow("process.exit(1)");
    expect(allError()).toContain("Unknown command: foobar");
    expect(allLog()).toContain("USAGE:");
    expect(exitCode).toBe(1);
  });
});

describe("run() - detect command", () => {
  it("shows detection header", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    mockRegistryList.mockReturnValue([]);
    await run(["detect"]);
    expect(allLog()).toContain("Detecting AI coding tools with MCP support...");
  });

  it("lists detected and missing tools", async () => {
    const detected = makeAdapter({ id: "claude-code", name: "Claude Code" });
    const missing = makeAdapter({ id: "codex", name: "Codex" });

    mockRegistryDetectAll.mockResolvedValue([detected]);
    mockRegistryList.mockReturnValue(["claude-code", "codex"]);
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return detected;
      if (id === "codex") return missing;
      return undefined;
    });

    await run(["detect"]);
    const output = allLog();
    expect(output).toContain("\u2713");
    expect(output).toContain("Claude Code");
    expect(output).toContain("\u2717");
    expect(output).toContain("Codex");
  });

  it("shows detection summary with counts", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    mockRegistryList.mockReturnValue(["claude-code", "codex", "gemini-cli"]);
    mockRegistryGet.mockReturnValue(adapter);

    await run(["detect"]);
    expect(allLog()).toContain("Detected 1/3 tools");
  });
});

describe("run() - generate command", () => {
  it("prints message when no tools detected and no --tools flag", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);

    await run(["generate"]);
    expect(allLog()).toContain("No AI tools detected");
    expect(allLog()).toContain("--tools");
  });

  it("generates configs for detected adapters", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await withConfig([stdioServer("github")], async (configPath) => {
      await run(["generate", `--config=${configPath}`]);
    });
    expect(allLog()).toContain("Generating MCP configs for 1 tool(s)");
    expect(allLog()).toContain("Generated: .test/mcp.json");
    expect(allLog()).toContain("Done!");
  });

  it("respects --dry-run and does not write files", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await withConfig([stdioServer("github")], async (configPath) => {
      await run(["generate", `--config=${configPath}`, "--dry-run"]);
    });
    expect(allLog()).toContain("[dry-run] Would write: .test/mcp.json");
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
  });

  it("uses --tools flag to resolve specific adapters", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await withConfig([stdioServer("github")], async (configPath) => {
      await run(["generate", `--config=${configPath}`, "--tools=claude-code"]);
    });
    expect(allLog()).toContain("Generating MCP configs for 1 tool(s)");
    expect(mockRegistryDetectAll).not.toHaveBeenCalled();
  });

  it("warns for unknown adapter IDs in --tools flag", async () => {
    mockRegistryGet.mockReturnValue(undefined);

    await run(["generate", "--tools=nonexistent"]);
    expect(allWarn()).toContain('Warning: Unknown adapter "nonexistent"');
    expect(allLog()).toContain("No AI tools detected");
  });

  it("refuses to generate an empty server list that would wipe tool configs", async () => {
    const generateFn = encodeGenerate(".cursor/mcp.json");
    const adapter = makeAdapter({
      id: "cursor",
      name: "Cursor",
      generate: generateFn,
    });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await expect(run(["generate"])).rejects.toThrow("process.exit(1)");
    expect(allError()).toContain(
      "No servers selected from mcp.config.ts. Refusing to write an empty MCP config.",
    );
    expect(exitCode).toBe(1);
    expect(generateFn).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe("run() - install command", () => {
  it("prints message when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);

    await run(["install"]);
    expect(allLog()).toContain("No AI tools detected");
  });

  it("installs MCP servers into detected tools", async () => {
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      install: installFn,
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await withConfig([stdioServer("github")], async (configPath) => {
      await run(["install", `--config=${configPath}`]);
    });
    expect(installFn).toHaveBeenCalled();
    expect(allLog()).toContain("Installing MCP servers into 1 tool(s)");
    expect(allLog()).toContain("\u2713 Claude Code");
    expect(allLog()).toContain("MCP servers installed!");
  });

  it("respects --dry-run and does not call install", async () => {
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      install: installFn,
      generate: vi
        .fn<(servers: MCPServerDefinition[]) => Promise<GeneratedFile[]>>()
        .mockResolvedValue([{ path: ".mcp.json", content: "{}", format: "json" }]),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await withConfig([stdioServer("github")], async (configPath) => {
      await run(["install", `--config=${configPath}`, "--dry-run"]);
    });
    expect(installFn).not.toHaveBeenCalled();
    expect(allLog()).toContain("[dry-run] Would install: .mcp.json");
  });

  it("skips undetected tool in --tools and warns", async () => {
    const adapter = makeAdapter({
      id: "kiro",
      name: "Kiro",
      detect: vi.fn<(cwd?: string) => Promise<boolean>>().mockResolvedValue(false),
    });

    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "kiro") return adapter;
      return undefined;
    });

    await run(["install", "--tools=kiro"]);
    expect(allWarn()).toContain("Kiro not detected, skipping");
    expect(allWarn()).toContain("--force");
    expect(allLog()).toContain("No AI tools detected");
  });

  it("--force bypasses detection check for --tools", async () => {
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "kiro",
      name: "Kiro",
      detect: vi.fn<(cwd?: string) => Promise<boolean>>().mockResolvedValue(false),
      install: installFn,
    });

    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "kiro") return adapter;
      return undefined;
    });

    await withConfig([stdioServer("github")], async (configPath) => {
      await run(["install", `--config=${configPath}`, "--tools=kiro", "--force"]);
    });
    expect(installFn).toHaveBeenCalled();
    expect(allLog()).toContain("Installing MCP servers into 1 tool(s)");
  });

  it("honors --layer and whenPathContains from mcp.config.ts like sync", async () => {
    const acme = stdioServer("acme", {
      layer: "project",
      whenPathContains: ["AcmeCorp"],
      transport: { type: "stdio", command: "/usr/local/bin/op-run-acme" },
    });
    const github = stdioServer("github", {
      layer: "project",
      transport: { type: "stdio", command: "npx" },
    });
    const generateFn = encodeGenerate(".mcp.json");
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      generate: generateFn,
      install: installFn,
    });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace/Development/OtherOrg/web");

    try {
      await withConfig([acme, github], async (configPath) => {
        await run(["install", `--config=${configPath}`, "--layer=project"]);
      });
    } finally {
      cwdSpy.mockRestore();
    }

    expect(generateFn.mock.calls[0]![0]!.map((s) => s.id)).toEqual(["github"]);
    expect(installFn).toHaveBeenCalledWith(
      [{ path: ".mcp.json", content: encodedMcpContent([github]), format: "json" }],
      "/workspace/Development/OtherOrg/web",
    );
    expect(installFn.mock.calls[0]![0]![0]!.content).not.toContain("acme");
  });

  it("refuses to install an empty server list that would wipe tool configs", async () => {
    const generateFn = encodeGenerate(".cursor/mcp.json");
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "cursor",
      name: "Cursor",
      generate: generateFn,
      install: installFn,
    });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await expect(run(["install"])).rejects.toThrow("process.exit(1)");
    expect(allError()).toContain(
      "No servers selected from mcp.config.ts. Refusing to write an empty MCP config.",
    );
    expect(exitCode).toBe(1);
    expect(generateFn).not.toHaveBeenCalled();
    expect(installFn).not.toHaveBeenCalled();
  });
});

describe("run() - export command", () => {
  it("exports servers as JSON to stdout", async () => {
    const servers: MCPServerDefinition[] = [
      {
        id: "test",
        name: "test",
        transport: { type: "stdio", command: "npx", args: ["-y", "test"] },
      },
    ];
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      import: vi.fn<(cwd?: string) => Promise<MCPServerDefinition[]>>().mockResolvedValue(servers),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["export"]);
    const output = allLog();
    expect(output).toContain('"id": "test"');
    expect(output).toContain('"command": "npx"');
  });

  it("uses --tools flag", async () => {
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      import: vi.fn<(cwd?: string) => Promise<MCPServerDefinition[]>>().mockResolvedValue([]),
    });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await run(["export", "--tools=claude-code"]);
    expect(mockRegistryDetectAll).not.toHaveBeenCalled();
  });
});

describe("run() - import command", () => {
  it("imports servers from a detected tool", async () => {
    const servers: MCPServerDefinition[] = [
      {
        id: "test",
        name: "test",
        transport: { type: "stdio", command: "npx", args: ["-y", "test"] },
      },
    ];
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      import: vi.fn<(cwd?: string) => Promise<MCPServerDefinition[]>>().mockResolvedValue(servers),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await run(["import"]);
    expect(allLog()).toContain("Imported 1 server(s) from Claude Code");
  });

  it("prints message when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);

    await run(["import"]);
    expect(allLog()).toContain("No AI tools detected");
  });
});

describe("run() - sync command", () => {
  const acme = stdioServer("acme", {
    layer: "project",
    whenPathContains: ["AcmeCorp"],
    transport: {
      type: "stdio",
      command: "/usr/local/bin/op-run-acme",
    },
  });
  const github = stdioServer("github", {
    layer: "project",
    transport: { type: "stdio", command: "npx", args: ["-y", "github-mcp"] },
  });
  const unifi = stdioServer("unifi", {
    layer: "user",
    transport: { type: "stdio", command: "unifi-mcp" },
  });

  it("prints message when no tools detected", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);

    await run(["sync"]);
    expect(allLog()).toContain("No AI tools detected");
    expect(allLog()).toContain("--tools");
  });

  it("refuses to copy imported servers when mcp.config.ts is missing", async () => {
    const importFn = vi
      .fn<(cwd?: string) => Promise<MCPServerDefinition[]>>()
      .mockResolvedValue([acme]);
    const generateFn = encodeGenerate(".zcode/mcp.json");
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const zcode = makeAdapter({
      id: "zcode",
      name: "ZCode",
      import: importFn,
      generate: generateFn,
      install: installFn,
    });
    const cursor = makeAdapter({
      id: "cursor",
      name: "Cursor",
      import: vi.fn<(cwd?: string) => Promise<MCPServerDefinition[]>>().mockResolvedValue([]),
      generate: encodeGenerate(".cursor/mcp.json"),
      install: installFn,
    });

    mockRegistryDetectAll.mockResolvedValue([zcode, cursor]);

    await expect(run(["sync"])).rejects.toThrow("process.exit(1)");
    expect(allError()).toContain(
      "No servers to sync from mcp.config.ts. Refusing to copy imported servers between tools.",
    );
    expect(allError()).toContain(
      "Add servers to the config (or pass --config) and use install/sync from that list.",
    );
    expect(allLog()).not.toContain("Sync complete!");
    expect(exitCode).toBe(1);
    expect(importFn).not.toHaveBeenCalled();
    expect(generateFn).not.toHaveBeenCalled();
    expect(installFn).not.toHaveBeenCalled();
  });

  it("refuses when the config exists but selects no servers", async () => {
    const importFn = vi
      .fn<(cwd?: string) => Promise<MCPServerDefinition[]>>()
      .mockResolvedValue([acme]);
    const generateFn = encodeGenerate(".cursor/mcp.json");
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "cursor",
      name: "Cursor",
      import: importFn,
      generate: generateFn,
      install: installFn,
    });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await withConfig([], async (configPath) => {
      await expect(run(["sync", `--config=${configPath}`])).rejects.toThrow("process.exit(1)");
    });

    expect(allError()).toContain("Refusing to copy imported servers between tools");
    expect(exitCode).toBe(1);
    expect(importFn).not.toHaveBeenCalled();
    expect(generateFn).not.toHaveBeenCalled();
    expect(installFn).not.toHaveBeenCalled();
  });

  it("installs only configured server IDs and never imports from other tools", async () => {
    const zcodeGenerate = encodeGenerate(".zcode/mcp.json");
    const cursorGenerate = encodeGenerate(".cursor/mcp.json");
    const zcodeInstall = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const cursorInstall = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const zcodeImport = vi
      .fn<(cwd?: string) => Promise<MCPServerDefinition[]>>()
      .mockResolvedValue([acme, github]);
    const cursorImport = vi
      .fn<(cwd?: string) => Promise<MCPServerDefinition[]>>()
      .mockResolvedValue([]);

    const zcode = makeAdapter({
      id: "zcode",
      name: "ZCode",
      import: zcodeImport,
      generate: zcodeGenerate,
      install: zcodeInstall,
    });
    const cursor = makeAdapter({
      id: "cursor",
      name: "Cursor",
      import: cursorImport,
      generate: cursorGenerate,
      install: cursorInstall,
    });
    mockRegistryDetectAll.mockResolvedValue([zcode, cursor]);

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace/Development/OtherOrg/web");

    try {
      await withConfig([github], async (configPath) => {
        await run(["sync", `--config=${configPath}`, "--layer=project"]);
      });
    } finally {
      cwdSpy.mockRestore();
    }

    expect(zcodeImport).not.toHaveBeenCalled();
    expect(cursorImport).not.toHaveBeenCalled();
    expect(zcodeGenerate.mock.calls.map((call) => call[0]!.map((s) => s.id))).toEqual([["github"]]);
    expect(cursorGenerate.mock.calls.map((call) => call[0]!.map((s) => s.id))).toEqual([
      ["github"],
    ]);

    const expectedFiles: GeneratedFile[] = [
      { path: ".zcode/mcp.json", content: encodedMcpContent([github]), format: "json" },
    ];
    const expectedCursorFiles: GeneratedFile[] = [
      { path: ".cursor/mcp.json", content: encodedMcpContent([github]), format: "json" },
    ];
    expect(zcodeInstall).toHaveBeenCalledTimes(1);
    expect(zcodeInstall).toHaveBeenCalledWith(expectedFiles, "/workspace/Development/OtherOrg/web");
    expect(cursorInstall).toHaveBeenCalledTimes(1);
    expect(cursorInstall).toHaveBeenCalledWith(
      expectedCursorFiles,
      "/workspace/Development/OtherOrg/web",
    );
    expect(encodedMcpContent([github])).toBe(
      JSON.stringify({ mcpServers: { github: { command: "npx" } } }, null, 2),
    );
    expect(allLog()).toContain("Installing 1 configured server(s) onto 2 tool(s)");
    expect(allLog()).toContain("\u2713 ZCode");
    expect(allLog()).toContain("\u2713 Cursor");
    expect(allLog()).toContain("Sync complete!");
  });

  it("honors --layer=project and drops user-layer servers", async () => {
    const generateFn = encodeGenerate(".cursor/mcp.json");
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "cursor",
      name: "Cursor",
      generate: generateFn,
      install: installFn,
      import: vi.fn<(cwd?: string) => Promise<MCPServerDefinition[]>>().mockResolvedValue([unifi]),
    });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await withConfig([github, unifi], async (configPath) => {
      await run(["sync", `--config=${configPath}`, "--layer=project"]);
    });

    expect(generateFn.mock.calls[0]![0]!.map((s) => s.id)).toEqual(["github"]);
    expect(installFn).toHaveBeenCalledWith(
      [{ path: ".cursor/mcp.json", content: encodedMcpContent([github]), format: "json" }],
      process.cwd(),
    );
    expect(adapter.import).not.toHaveBeenCalled();
  });

  it("honors --layer=user, writes userConfigPath, and skips project servers", async () => {
    const generateFn = encodeGenerate(".cursor/mcp.json");
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "cursor",
      name: "Cursor",
      userConfigPath: "/tmp/fake-home/.cursor/mcp.json",
      generate: generateFn,
      install: installFn,
    });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await withConfig([github, unifi], async (configPath) => {
      await run(["sync", `--config=${configPath}`, "--layer=user"]);
    });

    expect(generateFn.mock.calls[0]![0]!.map((s) => s.id)).toEqual(["unifi"]);
    expect(installFn).toHaveBeenCalledTimes(1);
    expect(installFn.mock.calls[0]![0]).toEqual([
      {
        path: "/tmp/fake-home/.cursor/mcp.json",
        content: encodedMcpContent([unifi]),
        format: "json",
      },
    ]);
    expect(installFn.mock.calls[0]![1]).toBe(homedir());
    expect(installFn.mock.calls[0]![0]![0]!.path).not.toBe(`${homedir()}/.cursor/mcp.json`);
    expect(installFn.mock.calls[0]![0]![0]!.path).not.toBe(`${homedir()}/.zcode/mcp.json`);
    expect(installFn.mock.calls[0]![0]![0]!.path).not.toBe(`${homedir()}/.claude/mcp.json`);
    expect(installFn.mock.calls[0]![0]![0]!.path).not.toBe(`${homedir()}/.grok/mcp.json`);
  });

  it("honors whenPathContains and keeps path-gated servers in matching cwd", async () => {
    const generateFn = encodeGenerate(".claude/mcp.json");
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      generate: generateFn,
      install: installFn,
    });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace/Development/AcmeCorp/app");

    try {
      await withConfig([acme, github], async (configPath) => {
        await run(["sync", `--config=${configPath}`, "--layer=project"]);
      });
    } finally {
      cwdSpy.mockRestore();
    }

    expect(generateFn.mock.calls[0]![0]!.map((s) => s.id)).toEqual(["acme", "github"]);
    expect(installFn).toHaveBeenCalledWith(
      [
        {
          path: ".claude/mcp.json",
          content: encodedMcpContent([acme, github]),
          format: "json",
        },
      ],
      "/workspace/Development/AcmeCorp/app",
    );
  });

  it("honors whenPathContains and refuses path-gated leak into non-matching cwd", async () => {
    const generateFn = encodeGenerate(".claude/mcp.json");
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const importFn = vi
      .fn<(cwd?: string) => Promise<MCPServerDefinition[]>>()
      .mockResolvedValue([acme]);
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      generate: generateFn,
      install: installFn,
      import: importFn,
    });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace/Development/OtherOrg/web");

    try {
      await withConfig([acme], async (configPath) => {
        await expect(run(["sync", `--config=${configPath}`, "--layer=project"])).rejects.toThrow(
          "process.exit(1)",
        );
      });
    } finally {
      cwdSpy.mockRestore();
    }

    expect(allError()).toContain("Refusing to copy imported servers between tools");
    expect(importFn).not.toHaveBeenCalled();
    expect(generateFn).not.toHaveBeenCalled();
    expect(installFn).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
  });

  it("installs un-gated project servers in other repos while dropping path-gated servers", async () => {
    const generateFn = encodeGenerate(".claude/mcp.json");
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const adapter = makeAdapter({
      id: "claude-code",
      name: "Claude Code",
      generate: generateFn,
      install: installFn,
    });
    mockRegistryDetectAll.mockResolvedValue([adapter]);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/workspace/Development/OtherOrg/web");

    try {
      await withConfig([acme, github], async (configPath) => {
        await run(["sync", `--config=${configPath}`]);
      });
    } finally {
      cwdSpy.mockRestore();
    }

    expect(generateFn.mock.calls[0]![0]!.map((s) => s.id)).toEqual(["github"]);
    expect(installFn).toHaveBeenCalledWith(
      [{ path: ".claude/mcp.json", content: encodedMcpContent([github]), format: "json" }],
      "/workspace/Development/OtherOrg/web",
    );
    expect(encodedMcpContent([github])).not.toContain("acme");
    expect(encodedMcpContent([github])).not.toContain("op-run-acme");
  });

  it("respects --dry-run from config and does not install or import", async () => {
    const generateFn = encodeGenerate(".cursor/mcp.json");
    const installFn = vi
      .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const importFn = vi
      .fn<(cwd?: string) => Promise<MCPServerDefinition[]>>()
      .mockResolvedValue([acme]);
    const adapter = makeAdapter({
      id: "cursor",
      name: "Cursor",
      generate: generateFn,
      install: installFn,
      import: importFn,
    });
    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await withConfig([github], async (configPath) => {
      await run(["sync", `--config=${configPath}`, "--dry-run"]);
    });

    expect(installFn).not.toHaveBeenCalled();
    expect(importFn).not.toHaveBeenCalled();
    expect(generateFn.mock.calls[0]![0]!.map((s) => s.id)).toEqual(["github"]);
    expect(allLog()).toContain("[dry-run] Would write: .cursor/mcp.json");
    expect(allLog()).toContain("Sync complete!");
  });

  it("throws when --config points at a missing file", async () => {
    mockRegistryDetectAll.mockResolvedValue([makeAdapter()]);
    await expect(run(["sync", "--config=/tmp/does-not-exist-mcp.config.mjs"])).rejects.toThrow(
      "Config file not found: /tmp/does-not-exist-mcp.config.mjs",
    );
  });
});

describe("run() - flag parsing", () => {
  it("parses --tools flag with = syntax", async () => {
    const adapter = makeAdapter({ id: "claude-code", name: "Claude Code" });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "claude-code") return adapter;
      return undefined;
    });

    await withConfig([stdioServer("github")], async (configPath) => {
      await run(["generate", `--config=${configPath}`, "--tools=claude-code"]);
    });
    expect(mockRegistryGet).toHaveBeenCalledWith("claude-code");
    expect(mockRegistryDetectAll).not.toHaveBeenCalled();
  });

  it("parses --dry-run flag", async () => {
    mockRegistryDetectAll.mockResolvedValue([]);
    await run(["generate", "--dry-run"]);
    // No error means flag was parsed
  });

  it("parses --force flag", async () => {
    const adapter = makeAdapter({
      id: "kiro",
      name: "Kiro",
      detect: vi.fn<(cwd?: string) => Promise<boolean>>().mockResolvedValue(false),
    });
    mockRegistryGet.mockImplementation((id: string) => {
      if (id === "kiro") return adapter;
      return undefined;
    });

    await withConfig([stdioServer("github")], async (configPath) => {
      await run(["generate", `--config=${configPath}`, "--tools=kiro", "--force"]);
    });
    expect(allLog()).toContain("Generating MCP configs for 1 tool(s)");
  });
});

describe("run() - error propagation", () => {
  it("propagates adapter generate errors", async () => {
    const adapter = makeAdapter({
      id: "broken",
      name: "Broken",
      generate: vi
        .fn<(servers: MCPServerDefinition[]) => Promise<GeneratedFile[]>>()
        .mockRejectedValue(new Error("generate failed")),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await withConfig([stdioServer("github")], async (configPath) => {
      await expect(run(["generate", `--config=${configPath}`])).rejects.toThrow("generate failed");
    });
  });

  it("propagates adapter install errors", async () => {
    const adapter = makeAdapter({
      id: "broken",
      name: "Broken",
      install: vi
        .fn<(files: GeneratedFile[], cwd?: string) => Promise<void>>()
        .mockRejectedValue(new Error("install failed")),
    });

    mockRegistryDetectAll.mockResolvedValue([adapter]);

    await withConfig([stdioServer("github")], async (configPath) => {
      await expect(run(["install", `--config=${configPath}`])).rejects.toThrow("install failed");
    });
  });
});

describe("run() - audit command", () => {
  it("reports a clean scan", async () => {
    const adapter = makeAdapter({
      id: "cursor",
      name: "Cursor",
      importUser: vi.fn<() => Promise<MCPServerDefinition[]>>().mockResolvedValue([
        {
          id: "github",
          name: "github",
          transport: { type: "stdio", command: "gh-mcp" },
        },
      ]),
    });
    mockRegistryGetAll.mockReturnValue([adapter]);
    await run(["audit"]);
    expect(allLog()).toContain("No user-global MCP leaks found.");
  });

  it("exits 1 when a secret wrapper is in a user-global config", async () => {
    const adapter = makeAdapter({
      id: "zcode",
      name: "ZCode",
      importUser: vi.fn<() => Promise<MCPServerDefinition[]>>().mockResolvedValue([
        {
          id: "outline",
          name: "outline",
          transport: {
            type: "stdio",
            command: "/usr/local/bin/op-run-acme",
          },
        },
      ]),
    });
    mockRegistryGetAll.mockReturnValue([adapter]);
    await expect(run(["audit"])).rejects.toThrow("process.exit(1)");
    expect(allLog()).toContain("secret-wrapper-in-user-config");
    expect(exitCode).toBe(1);
  });
});
