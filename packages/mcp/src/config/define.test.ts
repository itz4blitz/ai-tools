import { describe, it, expect } from "vitest";
import { defineConfig } from "./define.js";
import type { MCPConfig } from "../types/index.js";

describe("defineConfig", () => {
  it("returns the same config object", () => {
    const config: MCPConfig = {
      servers: [
        {
          id: "test",
          name: "Test Server",
          transport: { type: "stdio", command: "npx", args: ["-y", "test-mcp"] },
        },
      ],
    };
    const result = defineConfig(config);
    expect(result).toBe(config);
  });

  it("returns empty servers array unchanged", () => {
    const config: MCPConfig = { servers: [] };
    const result = defineConfig(config);
    expect(result).toEqual({ servers: [] });
  });

  it("preserves all server fields", () => {
    const config: MCPConfig = {
      servers: [
        {
          id: "my-server",
          name: "My Server",
          description: "A test server",
          transport: { type: "stdio", command: "node", args: ["server.js"], env: { KEY: "val" } },
          enabled: true,
          tags: ["dev", "test"],
          layer: "project",
          whenPathContains: ["AcmeCorp"],
        },
      ],
    };
    const result = defineConfig(config);
    expect(result.servers[0]!.id).toBe("my-server");
    expect(result.servers[0]!.description).toBe("A test server");
    expect(result.servers[0]!.tags).toEqual(["dev", "test"]);
    expect(result.servers[0]!.layer).toBe("project");
    expect(result.servers[0]!.whenPathContains).toEqual(["AcmeCorp"]);
  });
});
