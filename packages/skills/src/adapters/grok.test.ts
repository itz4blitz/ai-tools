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

import { GrokSkillAdapter } from "./grok.js";

describe("GrokSkillAdapter", () => {
  let adapter: GrokSkillAdapter;
  let tmp: string;
  let fakeHome: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    adapter = new GrokSkillAdapter();
    tmp = await mkdtemp(join(tmpdir(), "grok-skills-"));
    fakeHome = await mkdtemp(join(tmpdir(), "grok-skills-home-"));
    mockHome.dir = fakeHome;
  });

  afterEach(async () => {
    mockHome.dir = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  it("writes SKILL.md directories with name set to skill.id", async () => {
    expect(adapter.id).toBe("grok");
    expect(adapter.configDir).toBe(".grok/skills");
    const files = await adapter.generate([
      {
        id: "commit-helper",
        name: "Commit Helper",
        description: "Make commits",
        content: "Use conventional commits.",
      },
    ]);
    expect(files[0]?.path).toBe(".grok/skills/commit-helper/SKILL.md");
    expect(files[0]?.content).toContain("name: commit-helper");
    expect(files[0]?.content).toContain("description: Make commits");
    expect(files[0]?.content).toContain("Use conventional commits.");
  });

  it("imports LF and CRLF SKILL.md directories from project disk", async () => {
    await mkdir(join(tmp, ".grok/skills/commit"), { recursive: true });
    await writeFile(
      join(tmp, ".grok/skills/commit/SKILL.md"),
      "---\r\nname: commit\r\ndescription: Make commits\r\n---\r\n\r\nUse conventional commits.\r\n",
      "utf-8",
    );

    const skills = await adapter.import(tmp);
    expect(skills).toEqual([
      {
        id: "commit",
        name: "commit",
        description: "Make commits",
        content: "Use conventional commits.",
      },
    ]);
  });

  it("imports user-layer skills via importUser()", async () => {
    await mkdir(join(fakeHome, ".grok/skills/review"), { recursive: true });
    await writeFile(
      join(fakeHome, ".grok/skills/review/SKILL.md"),
      "---\nname: review\ndescription: Code review\n---\n\nCheck edge cases.\n",
      "utf-8",
    );

    const skills = await adapter.importUser();
    expect(skills).toEqual([
      {
        id: "review",
        name: "review",
        description: "Code review",
        content: "Check edge cases.",
      },
    ]);
  });

  it("uninstalls .grok/skills from the project directory", async () => {
    const files = await adapter.generate([
      { id: "commit", name: "Commit", content: "Use conventional commits." },
    ]);
    await adapter.install(files, tmp);
    expect(existsSync(join(tmp, ".grok/skills/commit/SKILL.md"))).toBe(true);

    await adapter.uninstall(tmp);
    expect(existsSync(join(tmp, ".grok/skills"))).toBe(false);
  });

  it("returns empty when the skills dir is missing", async () => {
    expect(await adapter.import(tmp)).toEqual([]);
    expect(await adapter.importUser()).toEqual([]);
  });
});
