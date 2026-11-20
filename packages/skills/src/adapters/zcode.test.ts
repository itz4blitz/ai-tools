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
import { ZcodeSkillAdapter } from "./zcode.js";

describe("ZcodeSkillAdapter", () => {
  let adapter: ZcodeSkillAdapter;
  let tmp: string;
  let home: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "zcode-skills-"));
    home = await mkdtemp(join(tmpdir(), "zcode-skills-home-"));
    mockHome.value = home;
    adapter = new ZcodeSkillAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("emits name: skill.id in SKILL.md frontmatter", async () => {
    expect(adapter.id).toBe("zcode");
    expect(adapter.configDir).toBe(".zcode/skills");

    const files = await adapter.generate([
      {
        id: "ship-release",
        name: "Ship Release",
        description: "Release helper",
        content: "Ship it.",
      },
    ]);
    expect(files[0]?.path).toBe(".zcode/skills/ship-release/SKILL.md");
    expect(files[0]?.content).toContain("name: ship-release\n");
    expect(files[0]?.content).toContain("description: Release helper\n");
    expect(files[0]?.content).not.toContain("name: Ship Release");
  });

  it("installs, imports LF and CRLF SKILL.md files, and uninstalls cleanly", async () => {
    const files = await adapter.generate([
      { id: "ship", name: "Ship", description: "Deploy app", content: "Ship it." },
    ]);
    await adapter.install(files, tmp);

    // Also add a CRLF skill on disk and a sibling config.json to verify uninstall safety
    await mkdir(join(tmp, ".zcode", "skills", "crlf-skill"), { recursive: true });
    await writeFile(
      join(tmp, ".zcode", "skills", "crlf-skill", "SKILL.md"),
      "---\r\nname: crlf-skill\r\ndescription: Windows line endings\r\n---\r\n\r\nRun tests.\r\n",
      "utf-8",
    );
    await writeFile(join(tmp, ".zcode", "config.json"), '{"model":"keep"}\n', "utf-8");

    const skills = await adapter.import(tmp);
    expect(skills.map((s) => s.id).toSorted()).toEqual(["crlf-skill", "ship"]);
    const crlf = skills.find((s) => s.id === "crlf-skill");
    expect(crlf).toEqual({
      id: "crlf-skill",
      name: "crlf-skill",
      description: "Windows line endings",
      content: "Run tests.",
    });

    await adapter.uninstall(tmp);
    expect(existsSync(join(tmp, ".zcode", "skills"))).toBe(false);
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
