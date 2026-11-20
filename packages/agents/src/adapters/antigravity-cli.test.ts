import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockHome } = vi.hoisted(() => ({ mockHome: { value: "" } }));

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
import { AntigravityCliAgentAdapter } from "./antigravity-cli.js";

describe("AntigravityCliAgentAdapter", () => {
  let adapter: AntigravityCliAgentAdapter;
  let tmp: string;
  let home: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "agy-agents-"));
    home = await mkdtemp(join(tmpdir(), "agy-home-"));
    mockHome.value = home;
    adapter = new AntigravityCliAgentAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("targets Antigravity CLI with agy command", () => {
    expect(adapter.id).toBe("antigravity-cli");
    expect(adapter.name).toBe("Antigravity CLI");
    expect(adapter.configDir).toBe(".agents/agents");
    expect(adapter.command).toBe("agy");
  });

  it("detects .agents/agents directory, settings.json, and agy command", async () => {
    expect(await adapter.detect(tmp)).toBe(false);

    await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(join(home, ".gemini", "antigravity-cli", "settings.json"), "{}\n", "utf-8");
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(home, ".gemini"), { recursive: true, force: true });
    expect(await adapter.detect(tmp)).toBe(false);

    await mkdir(join(tmp, ".agents", "agents"), { recursive: true });
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(tmp, ".agents"), { recursive: true, force: true });
    vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof execFile);
    expect(await adapter.detect(tmp)).toBe(true);
  });

  it("generates, installs, imports (including CRLF), and uninstalls agents", async () => {
    const files = await adapter.generate([
      {
        id: "reviewer",
        name: "Reviewer",
        description: "Reviews code.",
        tools: ["read_file", "run_command"],
        model: "gemini-3-pro",
        instructions: "Review correctness and tests.",
      },
    ]);

    expect(files[0]?.path).toBe(".agents/agents/reviewer.md");
    await adapter.install(files, tmp);

    const installed = await readFile(join(tmp, ".agents/agents/reviewer.md"), "utf-8");
    expect(installed).toContain("description: Reviews code.");
    expect(installed).toContain("# Reviewer");

    // Write CRLF agent to verify cross-platform import
    await writeFile(
      join(tmp, ".agents/agents/crlf.md"),
      "---\r\ndescription: Windows agent.\r\n---\r\n\r\n# CRLF Agent\r\n\r\nHandle CRLF.\r\n",
      "utf-8",
    );

    const imported = await adapter.import(tmp);
    expect(imported).toHaveLength(2);
    expect(imported.find((a) => a.id === "reviewer")).toEqual({
      id: "reviewer",
      name: "Reviewer",
      description: "Reviews code.",
      tools: ["read_file", "run_command"],
      model: "gemini-3-pro",
      instructions: "Review correctness and tests.",
    });
    expect(imported.find((a) => a.id === "crlf")).toEqual({
      id: "crlf",
      name: "CRLF Agent",
      description: "Windows agent.",
      instructions: "Handle CRLF.",
    });

    await adapter.uninstall(tmp);
    expect(existsSync(join(tmp, ".agents/agents"))).toBe(false);
  });
});
