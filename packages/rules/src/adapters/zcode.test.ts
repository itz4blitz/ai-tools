import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockHome } = vi.hoisted(() => ({ mockHome: { value: "" } }));

vi.mock("./registry.js", () => ({ registry: { register: vi.fn() } }));

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
import { ZcodeRuleAdapter } from "./zcode.js";

describe("ZcodeRuleAdapter", () => {
  let adapter: ZcodeRuleAdapter;
  let tmp: string;
  let home: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await mkdtemp(join(tmpdir(), "zcode-rules-"));
    home = await mkdtemp(join(tmpdir(), "zcode-rules-home-"));
    mockHome.value = home;
    adapter = new ZcodeRuleAdapter();
  });

  afterEach(async () => {
    mockHome.value = "";
    await rm(tmp, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("generates, installs, imports, and uninstalls markdown rules under .zcode/rules", async () => {
    expect(adapter.id).toBe("zcode");
    expect(adapter.configDir).toBe(".zcode/rules");

    const files = await adapter.generate([
      { id: "style", name: "Style", content: "Be terse.", scope: { type: "always" } },
    ]);
    expect(files[0]?.path).toBe(".zcode/rules/style.md");

    await adapter.install(files, tmp);
    await writeFile(join(tmp, ".zcode", "config.json"), '{"model":"keep"}\n', "utf-8");

    const imported = await adapter.import(tmp);
    expect(imported).toEqual([
      { id: "style", name: "Style", content: "Be terse.", scope: { type: "always" } },
    ]);

    await adapter.uninstall(tmp);
    expect(existsSync(join(tmp, ".zcode", "rules"))).toBe(false);
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
    vi.mocked(exec).mockImplementation(((_cmd, cb) => {
      (cb as (error: Error | null) => void)(null);
    }) as typeof exec);
    expect(await adapter.detect(tmp)).toBe(true);
  });
});
