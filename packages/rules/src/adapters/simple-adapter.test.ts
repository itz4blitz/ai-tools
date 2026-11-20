import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SimpleMarkdownRuleAdapter } from "./simple-adapter.js";

class TestSimpleRuleAdapter extends SimpleMarkdownRuleAdapter {
  readonly id = "test-simple-crlf";
  readonly name = "Test Simple";
  readonly nativeSupport = true;
  readonly configDir = ".test-simple/rules";
}

describe("SimpleMarkdownRuleAdapter cross-platform parsing", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("parses Windows CRLF markdown rule files cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-tools-rules-crlf-"));
    dirs.push(dir);
    const rulesDir = join(dir, ".test-simple", "rules");
    await mkdir(rulesDir, { recursive: true });
    await writeFile(
      join(rulesDir, "style.md"),
      "# Style Guide\r\n\r\nUse strict mode.\r\nAvoid any.\r\n",
      "utf-8",
    );

    const adapter = new TestSimpleRuleAdapter();
    const imported = await adapter.import(dir);

    expect(imported).toEqual([
      {
        id: "style",
        name: "Style Guide",
        content: "Use strict mode.\nAvoid any.",
        scope: { type: "always" },
      },
    ]);
  });
});
