import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadPluginConfig, toPluginConfigModuleSpecifier } from "./load-config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadPluginConfig", () => {
  it("throws when the config file is missing", async () => {
    await expect(loadPluginConfig("/tmp/ai-tools-missing-plugin-config.mjs")).rejects.toThrow(
      "Plugin config not found",
    );
  });

  it("loads the default export from an existing config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-tools-plugin-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "ai-plugin.config.mjs");
    await writeFile(
      configPath,
      [
        "export default {",
        '  id: "release-confidence",',
        '  name: "Release Confidence",',
        '  version: "0.1.0",',
        "};",
      ].join("\n"),
      "utf-8",
    );

    const config = await loadPluginConfig(configPath);

    expect(config).toMatchObject({
      id: "release-confidence",
      name: "Release Confidence",
      version: "0.1.0",
    });
  });

  it("uses a file URL specifier for config imports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-tools-plugin-config-#"));
    tempDirs.push(dir);
    const configPath = join(dir, "ai-plugin.config.mjs");

    await expect(toPluginConfigModuleSpecifier(configPath)).resolves.toMatch(
      /^file:\/\/\/.*ai-tools-plugin-config-%23.*\/ai-plugin\.config\.mjs$/,
    );
  });

  it("throws a clear error when the config has no default export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-tools-plugin-config-nodefault-"));
    tempDirs.push(dir);
    const configPath = join(dir, "ai-plugin.config.mjs");
    await writeFile(configPath, "export const id = 'no-default';\n", "utf-8");

    await expect(loadPluginConfig(configPath)).rejects.toThrow("must have a default export object");
  });

  it("throws a clear error when the default export is not an object", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ai-tools-plugin-config-nonobj-"));
    tempDirs.push(dir);
    const configPath = join(dir, "ai-plugin.config.mjs");
    await writeFile(configPath, 'export default "not-an-object";\n', "utf-8");

    await expect(loadPluginConfig(configPath)).rejects.toThrow("must have a default export object");
  });
});
