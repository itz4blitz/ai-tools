import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SimpleMarkdownRuleAdapter } from "./simple-adapter.js";
import { registry } from "./registry.js";
import type { GeneratedFile, RuleDefinition } from "../types/index.js";

const INSTRUCTIONS_GLOB = ".opencode/instructions/*.md";
const OPENCODE_CONFIG_FILE = "opencode.json";
const OPENCODE_CONFIG_JSONC = "opencode.jsonc";
const AGENTS_MD_FILE = "AGENTS.md";

type OpenCodeConfig = {
  instructions?: string[];
  [key: string]: unknown;
};

export class OpenCodeRuleAdapter extends SimpleMarkdownRuleAdapter {
  readonly id = "opencode";
  readonly name = "OpenCode";
  readonly nativeSupport = true;
  readonly configDir = ".opencode/instructions";
  readonly command = "opencode";

  override async detect(cwd?: string): Promise<boolean> {
    const dir = cwd ?? process.cwd();
    if (
      existsSync(resolve(dir, this.configDir)) ||
      existsSync(resolve(dir, OPENCODE_CONFIG_FILE)) ||
      existsSync(resolve(dir, OPENCODE_CONFIG_JSONC)) ||
      existsSync(resolve(dir, AGENTS_MD_FILE))
    ) {
      return true;
    }
    return this.commandExists(this.command);
  }

  override async install(files: GeneratedFile[], cwd?: string): Promise<void> {
    await super.install(files, cwd);
    if (files.length === 0) return;

    const dir = cwd ?? process.cwd();
    const configPath = resolve(dir, OPENCODE_CONFIG_FILE);

    let config: OpenCodeConfig = {};
    if (existsSync(configPath)) {
      config = parseJsonc<OpenCodeConfig>(await readFile(configPath, "utf-8"));
    }

    const instructions = Array.isArray(config.instructions) ? [...config.instructions] : [];
    if (!instructions.includes(INSTRUCTIONS_GLOB)) {
      instructions.push(INSTRUCTIONS_GLOB);
    }

    config.instructions = instructions;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  }

  override async import(cwd?: string): Promise<RuleDefinition[]> {
    const rules = await super.import(cwd);
    const dir = cwd ?? process.cwd();
    const agentsMdPath = resolve(dir, AGENTS_MD_FILE);

    if (existsSync(agentsMdPath) && !rules.some((r) => r.id === "agents")) {
      const raw = await readFile(agentsMdPath, "utf-8");
      const trimmed = raw.trim();
      if (trimmed) {
        const lines = trimmed.split(/\r?\n/);
        let name = "AGENTS";
        let contentStart = 0;
        if (lines[0]?.startsWith("# ")) {
          name = lines[0].slice(2).trim();
          contentStart = 1;
          if (lines[contentStart]?.trim() === "") contentStart++;
        }
        const content = lines.slice(contentStart).join("\n").trim();
        rules.push({ id: "agents", name, content, scope: { type: "always" } });
      }
    }

    return rules;
  }

  override async uninstall(cwd?: string): Promise<void> {
    const dir = cwd ?? process.cwd();
    const rulesDir = resolve(dir, this.configDir);
    if (existsSync(rulesDir)) {
      await rm(rulesDir, { recursive: true, force: true });
    }

    const configPath = resolve(dir, OPENCODE_CONFIG_FILE);
    if (!existsSync(configPath)) return;

    const config = parseJsonc<OpenCodeConfig>(await readFile(configPath, "utf-8"));
    if (!Array.isArray(config.instructions)) return;

    const remaining = config.instructions.filter((entry) => entry !== INSTRUCTIONS_GLOB);
    if (remaining.length === 0) {
      delete config.instructions;
    } else {
      config.instructions = remaining;
    }

    if (Object.keys(config).length === 0) {
      await rm(configPath);
    } else {
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    }
  }
}

function stripJsonc(raw: string): string {
  let out = "";
  let inString = false;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inString) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < raw.length && raw[i] !== "\n" && raw[i] !== "\r") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }

  let cleaned = "";
  inString = false;
  for (let j = 0; j < out.length; j++) {
    const ch = out[j];
    const next = out[j + 1];

    if (inString) {
      cleaned += ch;
      if (ch === "\\" && next !== undefined) {
        cleaned += next;
        j++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      cleaned += ch;
      continue;
    }

    if (ch === ",") {
      let k = j + 1;
      while (k < out.length && /\s/.test(out.charAt(k))) k++;
      if (out[k] === "}" || out[k] === "]") continue;
    }

    cleaned += ch;
  }

  return cleaned;
}

function parseJsonc<T>(raw: string): T {
  return JSON.parse(stripJsonc(raw)) as T;
}

const adapter = new OpenCodeRuleAdapter();
registry.register(adapter);
export default adapter;
