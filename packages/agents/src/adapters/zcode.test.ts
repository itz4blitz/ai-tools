import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { ZcodeAgentAdapter } from "./zcode.js";

describe("ZcodeAgentAdapter", () => {
  let adapter: ZcodeAgentAdapter;
  let tmp: string;
  let home: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "zcode-agents-"));
    home = await mkdtemp(join(tmpdir(), "zcode-agents-home-"));
    mockHome.value = home;
    adapter = new ZcodeAgentAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("generates, installs, imports (LF + CRLF), and uninstalls markdown agents under .zcode/agents", async () => {
    expect(adapter.id).toBe("zcode");
    expect(adapter.configDir).toBe(".zcode/agents");

    const files = await adapter.generate([
      {
        id: "reviewer",
        name: "Reviewer",
        description: "Code reviewer",
        tools: ["read", "grep"],
        model: "claude-sonnet",
        instructions: "Review diffs.",
      },
    ]);
    expect(files[0]?.path).toBe(".zcode/agents/reviewer.md");

    await adapter.install(files, tmp);
    await writeFile(
      join(tmp, ".zcode", "agents", "crlf.md"),
      "---\r\ndescription: CRLF agent\r\n---\r\n\r\n# CRLF\r\n\r\nHandle Windows files.\r\n",
      "utf-8",
    );
    await writeFile(join(tmp, ".zcode", "config.json"), '{"model":"keep"}\n', "utf-8");

    const imported = await adapter.import(tmp);
    expect(imported.map((a) => a.id).toSorted()).toEqual(["crlf", "reviewer"]);
    expect(imported.find((a) => a.id === "reviewer")).toEqual({
      id: "reviewer",
      name: "Reviewer",
      description: "Code reviewer",
      tools: ["read", "grep"],
      model: "claude-sonnet",
      instructions: "Review diffs.",
    });
    expect(imported.find((a) => a.id === "crlf")).toEqual({
      id: "crlf",
      name: "CRLF",
      description: "CRLF agent",
      instructions: "Handle Windows files.",
    });

    await adapter.uninstall(tmp);
    expect(existsSync(join(tmp, ".zcode", "agents"))).toBe(false);
    expect(existsSync(join(tmp, ".zcode", "config.json"))).toBe(true);
  });

  it("detects ~/.zcode, project .zcode, and zcode binary", async () => {
    expect(await adapter.detect(tmp)).toBe(false);

    await mkdir(join(home, ".zcode"), { recursive: true });
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(home, ".zcode"), { recursive: true, force: true });
    await mkdir(join(tmp, ".zcode"), { recursive: true });
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(tmp, ".zcode"), { recursive: true, force: true });
    vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof execFile);
    expect(await adapter.detect(tmp)).toBe(true);
  });
});
