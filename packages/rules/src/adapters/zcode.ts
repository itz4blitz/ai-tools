import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SimpleMarkdownRuleAdapter } from "./simple-adapter.js";
import { registry } from "./registry.js";

export class ZcodeRuleAdapter extends SimpleMarkdownRuleAdapter {
  readonly id = "zcode";
  readonly name = "ZCode";
  readonly nativeSupport = true;
  readonly configDir = ".zcode/rules";
  readonly command = "zcode";

  override async detect(cwd?: string): Promise<boolean> {
    if (await super.detect(cwd)) return true;
    const dir = cwd ?? process.cwd();
    return existsSync(resolve(dir, ".zcode")) || existsSync(join(homedir(), ".zcode"));
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const rulesDir = resolve(dir, this.configDir);
    if (existsSync(rulesDir)) {
      await rm(rulesDir, { recursive: true, force: true });
    }
  }
}

const adapter = new ZcodeRuleAdapter();
registry.register(adapter);
export default adapter;
