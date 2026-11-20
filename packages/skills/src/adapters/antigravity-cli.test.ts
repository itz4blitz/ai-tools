import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillDefinition } from "../types/index.js";

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
import { AntigravityCliSkillAdapter } from "./antigravity-cli.js";

describe("AntigravityCliSkillAdapter", () => {
  let adapter: AntigravityCliSkillAdapter;
  let tmp: string;
  let home: string;

  const testSkill: SkillDefinition = {
    id: "review",
    name: "Review",
    description: "Review code changes.",
    content: "Review correctness, security, and missing tests.",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "agy-skills-"));
    home = await mkdtemp(join(tmpdir(), "agy-home-"));
    mockHome.value = home;
    adapter = new AntigravityCliSkillAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("targets Antigravity workspace and user skills with agy command", () => {
    expect(adapter.id).toBe("antigravity-cli");
    expect(adapter.name).toBe("Antigravity CLI");
    expect(adapter.configDir).toBe(".agents/skills");
    expect(adapter.userConfigDir).toBe(".gemini/config/skills");
    expect(adapter.command).toBe("agy");
  });

  it("detects .agents/skills, ~/.gemini/antigravity-cli/settings.json, and agy command", async () => {
    expect(await adapter.detect(tmp)).toBe(false);

    await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(join(home, ".gemini", "antigravity-cli", "settings.json"), "{}\n", "utf-8");
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(home, ".gemini"), { recursive: true, force: true });
    await mkdir(join(tmp, ".agents", "skills"), { recursive: true });
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(tmp, ".agents"), { recursive: true, force: true });
    vi.mocked(execFile).mockImplementation(((_cmd, _args, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof execFile);
    expect(await adapter.detect(tmp)).toBe(true);
  });

  it("generates project and user skill folders", async () => {
    const projectFiles = await adapter.generate([testSkill]);
    expect(projectFiles).toEqual([
      {
        path: ".agents/skills/review/SKILL.md",
        format: "md",
        content: expect.stringContaining("name: review"),
      },
    ]);

    const userFiles = await adapter.generate([testSkill], "user");
    expect(userFiles[0]?.path).toBe(".gemini/config/skills/review/SKILL.md");
  });

  it("imports skills with CRLF and multiline YAML (>- and |), skips non-directories, and uninstalls", async () => {
    const skillsRoot = join(tmp, ".agents", "skills");
    await mkdir(join(skillsRoot, "folded"), { recursive: true });
    await mkdir(join(skillsRoot, "literal"), { recursive: true });
    await mkdir(join(skillsRoot, "empty-folder"), { recursive: true });
    await writeFile(join(skillsRoot, "README.md"), "Not a skill folder\n", "utf-8");

    await writeFile(
      join(skillsRoot, "folded", "SKILL.md"),
      "---\r\nname: folded-skill\r\ndescription: >-\r\n  First line of\r\n  folded description.\r\n---\r\n\r\nBody here.\r\n",
      "utf-8",
    );
    await writeFile(
      join(skillsRoot, "literal", "SKILL.md"),
      "---\nname: literal-skill\ndescription: |\n  Line one.\n  Line two.\n---\n\nLiteral body.\n",
      "utf-8",
    );

    const imported = await adapter.import(tmp);
    expect(imported).toHaveLength(2);
    expect(imported.find((s) => s.id === "folded")).toEqual({
      id: "folded",
      name: "folded-skill",
      description: "First line of folded description.",
      content: "Body here.",
    });
    expect(imported.find((s) => s.id === "literal")).toEqual({
      id: "literal",
      name: "literal-skill",
      description: "Line one.\nLine two.",
      content: "Literal body.",
    });

    await adapter.uninstall(tmp);
    expect(existsSync(skillsRoot)).toBe(false);
  });
});
