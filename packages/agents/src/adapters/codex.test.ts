import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

import { CodexAgentAdapter } from "./codex.js";
import type { AgentDefinition } from "../types/index.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ai-tools-agents-codex-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("CodexAgentAdapter", () => {
  let adapter: CodexAgentAdapter;
  let originalCodexHome: string | undefined;

  const testAgent: AgentDefinition = {
    id: "reviewer",
    name: "Code Reviewer",
    description: "Reviews code for correctness and missing tests.",
    instructions: "Review code like an owner.\nPrioritize correctness.",
    model: "gpt-5.5",
  };

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    vi.clearAllMocks();
    adapter = new CodexAgentAdapter();
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  });

  describe("metadata", () => {
    it("targets Codex custom agents with transform installStrategy", () => {
      expect(adapter.id).toBe("codex");
      expect(adapter.name).toBe("Codex");
      expect(adapter.nativeSupport).toBe(true);
      expect(adapter.configDir).toBe(".codex/agents");
      expect(adapter.userConfigDir).toBe(".codex/agents");
      expect(adapter.installStrategy).toBe("transform");
      expect(adapter.command).toBe("codex");
    });
  });

  describe("generate", () => {
    it("returns empty array for no agents", async () => {
      await expect(adapter.generate([])).resolves.toEqual([]);
    });

    it("writes one TOML file per Codex custom agent", async () => {
      const files = await adapter.generate([testAgent]);

      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe(".codex/agents/reviewer.toml");
      expect(files[0]?.format).toBe("toml");
      expect(files[0]?.content).toContain('name = "Code Reviewer"');
      expect(files[0]?.content).toContain(
        'description = "Reviews code for correctness and missing tests."',
      );
      expect(files[0]?.content).toContain(
        'developer_instructions = "Review code like an owner.\\nPrioritize correctness."',
      );
      expect(files[0]?.content).toContain('model = "gpt-5.5"');
    });

    it("omits optional model when not provided", async () => {
      const files = await adapter.generate([
        { id: "worker", name: "Worker", instructions: "Implement focused changes." },
      ]);

      expect(files[0]!.content).not.toContain("model =");
    });
  });

  describe("import", () => {
    it("returns empty array when config dir does not exist", async () => {
      await withTempDir(async (dir) => {
        await expect(adapter.import(dir)).resolves.toEqual([]);
      });
    });

    it("parses multiline basic/literal strings, literal single-line strings, inline comments, and ignores nested [tables]", async () => {
      await withTempDir(async (dir) => {
        const agentsDir = join(dir, ".codex", "agents");
        await mkdir(agentsDir, { recursive: true });

        await writeFile(
          join(agentsDir, "reviewer.toml"),
          [
            'name = "Code Reviewer" # display name',
            "description = 'Reviews PRs with \"strict\" checks' # literal string",
            'model = "gpt-5.5" # preferred model',
            'developer_instructions = """',
            "Line 1: Check correctness.",
            'Line 2: Quote "escaped" text.',
            '""" # end multiline',
            "",
            "[mcp_servers.nested]",
            'name = "SHOULD_NOT_OVERWRITE"',
            'model = "wrong-model"',
            'description = "wrong-desc"',
          ].join("\n"),
          "utf-8",
        );

        await writeFile(
          join(agentsDir, "literal.toml"),
          [
            "name = 'Literal Agent'",
            "developer_instructions = '''",
            "Keep C:\\raw\\path verbatim.",
            "Line two.",
            "'''",
          ].join("\r\n"),
          "utf-8",
        );

        await writeFile(join(agentsDir, "README.md"), "# ignore", "utf-8");

        const agents = await adapter.import(dir);
        expect(agents).toHaveLength(2);

        const reviewer = agents.find((a) => a.id === "reviewer");
        expect(reviewer).toEqual({
          id: "reviewer",
          name: "Code Reviewer",
          description: 'Reviews PRs with "strict" checks',
          instructions: 'Line 1: Check correctness.\nLine 2: Quote "escaped" text.\n',
          model: "gpt-5.5",
        });

        const literal = agents.find((a) => a.id === "literal");
        expect(literal).toEqual({
          id: "literal",
          name: "Literal Agent",
          description: undefined,
          instructions: "Keep C:\\raw\\path verbatim.\nLine two.\n",
          model: undefined,
        });
      });
    });

    it("imports user-layer agents from $CODEX_HOME/agents", async () => {
      await withTempDir(async (dir) => {
        process.env.CODEX_HOME = dir;
        const userAgentsDir = join(dir, "agents");
        await mkdir(userAgentsDir, { recursive: true });
        await writeFile(
          join(userAgentsDir, "helper.toml"),
          'name = "User Helper"\ndeveloper_instructions = "Help globally."\n',
          "utf-8",
        );

        const agents = await adapter.importUser();
        expect(agents).toHaveLength(1);
        expect(agents[0]?.id).toBe("helper");
        expect(agents[0]?.name).toBe("User Helper");
        expect(agents[0]?.instructions).toBe("Help globally.");
      });
    });
  });

  describe("install and uninstall", () => {
    it("installs TOML agents and removes them on uninstall", async () => {
      await withTempDir(async (dir) => {
        const files = await adapter.generate([testAgent]);
        await adapter.install(files, dir);

        const agentPath = join(dir, ".codex", "agents", "reviewer.toml");
        expect(existsSync(agentPath)).toBe(true);

        await adapter.uninstall(dir);
        expect(existsSync(agentPath)).toBe(false);
        expect(existsSync(join(dir, ".codex", "agents"))).toBe(false);
      });
    });
  });
});
