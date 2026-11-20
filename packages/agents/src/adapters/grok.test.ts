import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockHome = vi.hoisted(() => ({ dir: "" }));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => mockHome.dir || actual.homedir(),
  };
});

vi.mock("./registry.js", () => ({
  registry: { register: vi.fn() },
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: (error: Error | null) => void) => {
    cb(new Error("not found"));
  }),
}));

import { GrokAgentAdapter } from "./grok.js";

describe("GrokAgentAdapter", () => {
  let adapter: GrokAgentAdapter;
  let tmp: string;
  let fakeHome: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new GrokAgentAdapter();
    tmp = await mkdtemp(join(tmpdir(), "grok-agents-"));
    fakeHome = await mkdtemp(join(tmpdir(), "grok-agents-home-"));
    mockHome.dir = fakeHome;
  });

  afterEach(async () => {
    mockHome.dir = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("writes and imports markdown agents under .grok/agents", async () => {
    expect(adapter.id).toBe("grok");
    expect(adapter.configDir).toBe(".grok/agents");
    expect(adapter.userAgentsDir).toBe(join(fakeHome, ".grok", "agents"));

    const files = await adapter.generate([
      {
        id: "explore",
        name: "Explore",
        description: "Fast codebase explorer",
        tools: ["Read", "Grep"],
        model: "grok-3",
        instructions: "Search the repo.",
      },
    ]);
    expect(files[0]?.path).toBe(".grok/agents/explore.md");
    expect(files[0]?.content).toContain("# Explore");
    expect(files[0]?.content).toContain("Search the repo.");

    await adapter.install(files, tmp);
    const imported = await adapter.import(tmp);
    expect(imported).toEqual([
      {
        id: "explore",
        name: "Explore",
        description: "Fast codebase explorer",
        tools: ["Read", "Grep"],
        model: "grok-3",
        instructions: "Search the repo.",
      },
    ]);
  });

  it("imports user-layer agents from ~/.grok/agents and detects user dir", async () => {
    expect(await adapter.detect(tmp)).toBe(false);

    await mkdir(join(fakeHome, ".grok/agents"), { recursive: true });
    await writeFile(
      join(fakeHome, ".grok/agents/reviewer.md"),
      "---\r\ndescription: Code reviewer\r\n---\r\n\r\n# Reviewer\r\n\r\nReview diffs carefully.\r\n",
      "utf-8",
    );

    expect(await adapter.detect(tmp)).toBe(true);
    const userAgents = await adapter.importUser();
    expect(userAgents).toEqual([
      {
        id: "reviewer",
        name: "Reviewer",
        description: "Code reviewer",
        instructions: "Review diffs carefully.",
      },
    ]);
  });

  it("uninstalls .grok/agents from the project directory", async () => {
    const files = await adapter.generate([
      { id: "explore", name: "Explore", instructions: "Search the repo." },
    ]);
    await adapter.install(files, tmp);
    expect(existsSync(join(tmp, ".grok/agents/explore.md"))).toBe(true);

    await adapter.uninstall(tmp);
    expect(existsSync(join(tmp, ".grok/agents"))).toBe(false);
  });
});
