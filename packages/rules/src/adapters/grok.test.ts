import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./registry.js", () => ({ registry: { register: vi.fn() } }));

import { GrokRuleAdapter } from "./grok.js";

const temps: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grok-rules-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("GrokRuleAdapter", () => {
  it("writes and imports Claude-compatible frontmatter preserving description and glob scope", async () => {
    const tmp = await makeTempDir();
    const adapter = new GrokRuleAdapter();
    expect(adapter.id).toBe("grok");
    expect(adapter.configDir).toBe(".grok/rules");

    const files = await adapter.generate([
      {
        id: "ts-strict",
        name: "ts-strict",
        description: "Strict TypeScript guidelines",
        content: "No any.",
        scope: { type: "glob", patterns: ["src/**/*.ts", "tests/**/*.ts"] },
      },
      {
        id: "always-rule",
        name: "always-rule",
        content: "Keep functions small.",
        scope: { type: "always" },
      },
    ]);

    expect(files[0]?.path).toBe(".grok/rules/ts-strict.md");
    expect(files[0]?.content).toContain("description: Strict TypeScript guidelines");
    expect(files[0]?.content).toContain('  - "src/**/*.ts"');
    expect(files[0]?.content).toContain("No any.");

    await adapter.install(files, tmp);
    const imported = await adapter.import(tmp);
    expect(imported).toEqual([
      {
        id: "always-rule",
        name: "always-rule",
        content: "Keep functions small.",
        scope: { type: "always" },
      },
      {
        id: "ts-strict",
        name: "ts-strict",
        description: "Strict TypeScript guidelines",
        content: "No any.",
        scope: { type: "glob", patterns: ["src/**/*.ts", "tests/**/*.ts"] },
      },
    ]);
  });

  it("parses CRLF frontmatter and plain markdown rules", async () => {
    const tmp = await makeTempDir();
    const adapter = new GrokRuleAdapter();
    await mkdir(join(tmp, ".grok/rules"), { recursive: true });
    await writeFile(
      join(tmp, ".grok/rules/crlf-rule.md"),
      '---\r\ndescription: Windows rule\r\nglobs:\r\n  - "*.ts"\r\n---\r\n\r\nUse strict mode.\r\n',
      "utf-8",
    );
    await writeFile(
      join(tmp, ".grok/rules/plain.md"),
      "# Plain Rule\r\n\r\nBe concise.\r\n",
      "utf-8",
    );

    const imported = await adapter.import(tmp);
    expect(imported).toEqual([
      {
        id: "crlf-rule",
        name: "crlf-rule",
        description: "Windows rule",
        content: "Use strict mode.",
        scope: { type: "glob", patterns: ["*.ts"] },
      },
      {
        id: "plain",
        name: "Plain Rule",
        content: "Be concise.",
        scope: { type: "always" },
      },
    ]);
  });

  it("uninstalls .grok/rules from the project directory", async () => {
    const tmp = await makeTempDir();
    const adapter = new GrokRuleAdapter();
    const files = await adapter.generate([
      { id: "ts-strict", name: "ts-strict", content: "No any.", scope: { type: "always" } },
    ]);
    await adapter.install(files, tmp);
    expect(existsSync(join(tmp, ".grok/rules/ts-strict.md"))).toBe(true);

    await adapter.uninstall(tmp);
    expect(existsSync(join(tmp, ".grok/rules"))).toBe(false);
  });
});
