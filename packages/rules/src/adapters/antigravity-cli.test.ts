import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  exec: vi.fn((_cmd: string, cb: (error: Error | null) => void) => {
    cb(new Error("not found"));
  }),
}));

import { exec } from "node:child_process";
import { AntigravityCliRuleAdapter } from "./antigravity-cli.js";

describe("AntigravityCliRuleAdapter", () => {
  let adapter: AntigravityCliRuleAdapter;
  let tmp: string;
  let home: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "agy-rules-"));
    home = await mkdtemp(join(tmpdir(), "agy-home-"));
    mockHome.value = home;
    adapter = new AntigravityCliRuleAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("targets Antigravity workspace rules with agy command", () => {
    expect(adapter.id).toBe("antigravity-cli");
    expect(adapter.name).toBe("Antigravity CLI");
    expect(adapter.configDir).toBe(".agents/rules");
    expect(adapter.command).toBe("agy");
  });

  it("detects .agents/rules, ~/.gemini/antigravity-cli/settings.json, and agy command", async () => {
    expect(await adapter.detect(tmp)).toBe(false);

    await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(join(home, ".gemini", "antigravity-cli", "settings.json"), "{}\n", "utf-8");
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(home, ".gemini"), { recursive: true, force: true });
    await mkdir(join(tmp, ".agents", "rules"), { recursive: true });
    expect(await adapter.detect(tmp)).toBe(true);

    await rm(join(tmp, ".agents"), { recursive: true, force: true });
    vi.mocked(exec).mockImplementation(((_cmd, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof exec);
    expect(await adapter.detect(tmp)).toBe(true);
  });

  it("emits and imports always_on and model_decision frontmatter, handles CRLF, and uninstalls", async () => {
    const files = await adapter.generate([
      {
        id: "testing",
        name: "Testing",
        content: "Use TDD and verify the failing test first.",
        scope: { type: "always" },
      },
      {
        id: "security",
        name: "Security",
        description: "Apply when touching auth or credentials.",
        content: "Never log secrets.",
        scope: { type: "manual" },
      },
    ]);

    expect(files[0]?.path).toBe(".agents/rules/testing.md");
    expect(files[0]?.content).toContain("trigger: always_on");
    expect(files[1]?.path).toBe(".agents/rules/security.md");
    expect(files[1]?.content).toContain("trigger: model_decision");
    expect(files[1]?.content).toContain("description: Apply when touching auth or credentials.");

    await adapter.install(files, tmp);

    await writeFile(
      join(tmp, ".agents/rules/crlf.md"),
      "---\r\ntrigger: model_decision\r\ndescription: CRLF rule\r\n---\r\n\r\n# CRLF Rule\r\n\r\nLine A.\r\n",
      "utf-8",
    );

    const imported = await adapter.import(tmp);
    expect(imported).toHaveLength(3);
    expect(imported.find((r) => r.id === "testing")).toEqual({
      id: "testing",
      name: "Testing",
      content: "Use TDD and verify the failing test first.",
      scope: { type: "always" },
    });
    expect(imported.find((r) => r.id === "security")).toEqual({
      id: "security",
      name: "Security",
      description: "Apply when touching auth or credentials.",
      content: "Never log secrets.",
      scope: { type: "manual" },
    });
    expect(imported.find((r) => r.id === "crlf")).toEqual({
      id: "crlf",
      name: "CRLF Rule",
      description: "CRLF rule",
      content: "Line A.",
      scope: { type: "manual" },
    });

    await adapter.uninstall(tmp);
    expect(existsSync(join(tmp, ".agents/rules"))).toBe(false);
  });
});
