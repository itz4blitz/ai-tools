import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
}));

vi.mock("node:path", () => ({
  resolve: (...args: string[]) => args.join("/"),
}));

import {
  computeManifestHealth,
  formatEngineRow,
  getConfigDashboardData,
  getEngineStatus,
  getToolDeployments,
} from "./config-dashboard.js";
import type { EngineStatus, ToolDeployment } from "./config-dashboard.js";
import { existsSync, readFileSync } from "node:fs";

beforeEach(() => {
  vi.clearAllMocks();
});

// -- getEngineStatus --

describe("getEngineStatus()", () => {
  it("returns status for all 5 engines", async () => {
    const statuses = await getEngineStatus();
    expect(statuses).toHaveLength(5);
    const engines = statuses.map((s) => s.engine);
    expect(engines).toContain("hooks");
    expect(engines).toContain("mcp");
    expect(engines).toContain("skills");
    expect(engines).toContain("agents");
    expect(engines).toContain("rules");
  });

  it("marks engines as not configured when no config files exist", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const statuses = await getEngineStatus();
    for (const status of statuses) {
      expect(status.configured).toBe(false);
      expect(status.detected).toBe(false);
    }
  });

  it("marks engine as configured when .ts config exists", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      return typeof path === "string" && path.includes("ai-hooks.config.ts");
    });

    const statuses = await getEngineStatus();
    const hooks = statuses.find((s) => s.engine === "hooks");
    expect(hooks?.configured).toBe(true);
    expect(hooks?.detected).toBe(true);
  });

  it("marks engine as configured when .js config exists", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      return typeof path === "string" && path.includes("ai-mcp.config.js");
    });

    const statuses = await getEngineStatus();
    const mcp = statuses.find((s) => s.engine === "mcp");
    expect(mcp?.configured).toBe(true);
  });

  it("detects mcp.config.ts and mcp.config.js for mcp engine", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      return typeof path === "string" && path.endsWith("/mcp.config.ts");
    });

    let statuses = await getEngineStatus();
    let mcp = statuses.find((s) => s.engine === "mcp");
    expect(mcp?.configured).toBe(true);
    expect(mcp?.configPath).toContain("mcp.config.ts");

    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      return typeof path === "string" && path.endsWith("/mcp.config.js");
    });

    statuses = await getEngineStatus();
    mcp = statuses.find((s) => s.engine === "mcp");
    expect(mcp?.configured).toBe(true);
    expect(mcp?.configPath).toContain("mcp.config.js");
  });

  it("detects multiple configured engines", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      return (
        (typeof path === "string" && path.includes("ai-hooks.config.ts")) ||
        (typeof path === "string" && path.includes("ai-skills.config.ts"))
      );
    });

    const statuses = await getEngineStatus();
    const configured = statuses.filter((s) => s.configured);
    expect(configured).toHaveLength(2);
  });

  it("marks engine as configured from .ai-tools/<file> when cwd has no config", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((path: unknown) => {
      const value = String(path);
      return value.endsWith("/.ai-tools") || value.includes("/.ai-tools/ai-rules.config.ts");
    });

    const statuses = await getEngineStatus();
    const rules = statuses.find((s) => s.engine === "rules");
    expect(rules?.configured).toBe(true);
    expect(rules?.configPath).toContain("/.ai-tools/ai-rules.config.ts");
  });

  it("marks engine as configured from .ai-tools/<engine>.json", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockImplementation((path: unknown) => {
      const value = String(path);
      return value.endsWith("/.ai-tools") || value.endsWith("/.ai-tools/mcp.json");
    });

    const statuses = await getEngineStatus();
    const mcp = statuses.find((s) => s.engine === "mcp");
    expect(mcp?.configured).toBe(true);
    expect(mcp?.configPath).toContain("/.ai-tools/mcp.json");
  });
});

describe("getToolDeployments()", () => {
  it("returns [] when the manifest is missing", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(await getToolDeployments()).toEqual([]);
  });

  it("returns [] when the manifest is invalid JSON", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("{not json");
    expect(await getToolDeployments()).toEqual([]);
  });

  it("flattens manifest targets into deployments", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
      JSON.stringify({
        version: 1,
        entries: [
          {
            engine: "mcp",
            id: "github",
            canonicalPath: ".ai-tools/mcp.json",
            updatedAt: "t",
            targets: [
              {
                adapterId: "cursor",
                targetPath: ".cursor/mcp.json",
                strategy: "transform",
                status: "direct",
              },
              {
                adapterId: "zcode",
                targetPath: ".zcode/config.json",
                strategy: "symlink",
                status: "stale",
              },
            ],
          },
        ],
      }),
    );

    expect(await getToolDeployments()).toEqual([
      {
        adapterId: "cursor",
        targetPath: ".cursor/mcp.json",
        strategy: "transform",
        status: "direct",
      },
      {
        adapterId: "zcode",
        targetPath: ".zcode/config.json",
        strategy: "symlink",
        status: "stale",
      },
    ]);
  });
});

describe("computeManifestHealth()", () => {
  it("counts linked, direct, stale, and missing targets", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const deployments: ToolDeployment[] = [
      { adapterId: "a", targetPath: "a", strategy: "transform", status: "linked" },
      { adapterId: "b", targetPath: "b", strategy: "transform", status: "direct" },
      { adapterId: "c", targetPath: "c", strategy: "symlink", status: "stale" },
      { adapterId: "d", targetPath: "d", strategy: "symlink", status: "missing" },
    ];
    expect(await computeManifestHealth(deployments)).toEqual({
      exists: true,
      entryCount: 4,
      linkedCount: 2,
      staleCount: 1,
      missingCount: 1,
    });
  });
});

describe("getConfigDashboardData()", () => {
  it("reports error when canonical mode has no manifest", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const data = await getConfigDashboardData("canonical");
    expect(data.configHealth).toBe("error");
    expect(data.manifestHealth.exists).toBe(false);
    expect(data.deployments).toEqual([]);
  });

  it("reports healthy in direct mode even without .ai-tools/manifest.json", async () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const data = await getConfigDashboardData("direct");
    expect(data.configHealth).toBe("healthy");
  });
});

// -- formatEngineRow --

describe("formatEngineRow()", () => {
  it("formats configured engine with checkmark", () => {
    const status: EngineStatus = { engine: "hooks", detected: true, configured: true };
    const row = formatEngineRow("hooks", status);
    expect(row).toContain("\u2713");
    expect(row).toContain("hooks");
    expect(row).toContain("configured");
  });

  it("formats unconfigured engine with cross", () => {
    const status: EngineStatus = { engine: "mcp", detected: false, configured: false };
    const row = formatEngineRow("mcp", status);
    expect(row).toContain("\u2717");
    expect(row).toContain("mcp");
    expect(row).toContain("not configured");
  });

  it("includes error message when present", () => {
    const status: EngineStatus = {
      engine: "rules",
      detected: false,
      configured: false,
      error: "file corrupted",
    };
    const row = formatEngineRow("rules", status);
    expect(row).toContain("file corrupted");
  });

  it("omits error when not present", () => {
    const status: EngineStatus = { engine: "agents", detected: true, configured: true };
    const row = formatEngineRow("agents", status);
    expect(row).not.toContain("(");
  });
});
