import { describe, expect, it } from "vitest";
import { filterServers } from "./scope.js";
import type { MCPServerDefinition } from "./types/index.js";

const stdio = (id: string, extra: Partial<MCPServerDefinition> = {}): MCPServerDefinition => ({
  id,
  name: id,
  transport: { type: "stdio", command: "npx" },
  ...extra,
});

describe("filterServers", () => {
  it("defaults missing layer to project", () => {
    const servers = [stdio("github")];
    expect(
      filterServers(servers, { layer: "project", cwd: "/workspace/app" }).map((s) => s.id),
    ).toEqual(["github"]);
    expect(filterServers(servers, { layer: "user", cwd: "/workspace/app" })).toEqual([]);
  });

  it("keeps user-layer servers only for user installs", () => {
    const servers = [stdio("unifi", { layer: "user" }), stdio("repo-lint", { layer: "project" })];
    expect(filterServers(servers, { layer: "user", cwd: "/tmp" }).map((s) => s.id)).toEqual([
      "unifi",
    ]);
    expect(filterServers(servers, { layer: "project", cwd: "/tmp" }).map((s) => s.id)).toEqual([
      "repo-lint",
    ]);
  });

  it("restricts path-gated servers to matching project paths", () => {
    const servers = [
      stdio("acme", { layer: "project", whenPathContains: ["AcmeCorp"] }),
      stdio("outline", { layer: "project", whenPathContains: ["AcmeCorp"] }),
      stdio("github", { layer: "project" }),
    ];
    const inAcme = filterServers(servers, {
      layer: "project",
      cwd: "/workspace/Development/AcmeCorp/app",
    }).map((s) => s.id);
    expect(inAcme).toEqual(["acme", "outline", "github"]);

    const inOther = filterServers(servers, {
      layer: "project",
      cwd: "/workspace/Development/OtherOrg/web",
    }).map((s) => s.id);
    expect(inOther).toEqual(["github"]);
  });

  it("never installs path-gated servers into the user layer", () => {
    const servers = [stdio("acme", { layer: "project", whenPathContains: ["AcmeCorp"] })];
    expect(
      filterServers(servers, {
        layer: "user",
        cwd: "/workspace/Development/AcmeCorp/app",
      }),
    ).toEqual([]);
  });

  it("matches any fragment in whenPathContains", () => {
    const servers = [
      stdio("acme", { layer: "project", whenPathContains: ["AcmeCorp", "acmecorp"] }),
    ];
    expect(
      filterServers(servers, { layer: "project", cwd: "/tmp/acmecorp-scratch" }).map((s) => s.id),
    ).toEqual(["acme"]);
  });
});
