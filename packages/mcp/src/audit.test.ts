import { describe, expect, it } from "vitest";
import { auditServers } from "./audit.js";
import type { MCPServerDefinition } from "./types/index.js";

describe("auditServers", () => {
  it("flags interactive secret-wrapper commands in user configs but not allowlisted service accounts", () => {
    const interactive: MCPServerDefinition = {
      id: "docs",
      name: "docs",
      transport: {
        type: "stdio",
        command: "/usr/local/bin/op-run-acme",
        args: ["npx", "mcp-remote", "https://docs.acme.example/mcp"],
      },
    };
    const headless: MCPServerDefinition = {
      id: "docs-sa",
      name: "docs-sa",
      transport: {
        type: "stdio",
        command: "/usr/local/bin/op-run-acme-sa",
        args: ["npx"],
      },
    };
    const findings = [
      ...auditServers("cursor", [interactive], "user"),
      ...auditServers("cursor", [headless], "user"),
    ];
    expect(findings.some((f) => f.kind === "secret-wrapper-in-user-config")).toBe(true);
    expect(
      findings.filter((f) => f.server === "docs-sa" && f.kind === "secret-wrapper-in-user-config"),
    ).toEqual([]);
  });

  it("flags project-scoped and projectOnlyIds servers in user-global configs, not project configs", () => {
    const projectLayered: MCPServerDefinition = {
      id: "internal-api",
      name: "internal-api",
      layer: "project",
      whenPathContains: ["AcmeCorp"],
      transport: { type: "stdio", command: "/usr/local/bin/internal-mcp-stdio" },
    };
    const configuredProjectOnly: MCPServerDefinition = {
      id: "outline",
      name: "outline",
      transport: { type: "stdio", command: "outline-mcp" },
    };

    expect(auditServers("zcode", [projectLayered], "user").map((f) => f.kind)).toContain(
      "project-server-in-user-config",
    );
    expect(auditServers("zcode", [projectLayered], "project").map((f) => f.kind)).not.toContain(
      "project-server-in-user-config",
    );
    expect(
      auditServers("zcode", [configuredProjectOnly], "user", {
        projectOnlyIds: ["outline"],
      }).map((f) => f.kind),
    ).toContain("project-server-in-user-config");
  });

  it("flags configured forbidden org/domain patterns in user configs", () => {
    const server: MCPServerDefinition = {
      id: "linear",
      name: "linear",
      transport: {
        type: "stdio",
        command: "/usr/local/bin/linear-mcp-acme",
        args: ["--org", "acme.internal"],
      },
    };
    const findings = auditServers("cursor", [server], "user", {
      forbiddenPatterns: ["acme.internal", "linear-mcp-acme"],
    });
    expect(findings.map((f) => f.kind)).toContain("org-pattern-in-user-config");
    expect(
      auditServers("cursor", [server], "project", {
        forbiddenPatterns: ["acme.internal"],
      }),
    ).toEqual([]);
  });

  it("flags interactive secret-manager env vars such as OP_ACCOUNT in user configs", () => {
    const server: MCPServerDefinition = {
      id: "tracker",
      name: "tracker",
      transport: {
        type: "stdio",
        command: "/usr/local/bin/tracker-mcp",
        env: { OP_ACCOUNT: "acme.1password.com" },
      },
    };
    const kinds = auditServers("zcode", [server], "user").map((f) => f.kind);
    expect(kinds).toContain("secret-wrapper-in-user-config");
  });

  it("handles Windows backslash paths when inspecting wrapper basenames", () => {
    const server: MCPServerDefinition = {
      id: "win-docs",
      name: "win-docs",
      transport: {
        type: "stdio",
        command: "C:\\Users\\dev\\.local\\bin\\op-run-corp",
      },
    };
    expect(auditServers("cursor", [server], "user").map((f) => f.kind)).toContain(
      "secret-wrapper-in-user-config",
    );
  });
});
