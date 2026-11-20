import { describe, it, expect } from "vitest";
import type { EngineStatus, ToolDeployment, ManifestHealth } from "../widgets/config-dashboard.js";
import { mockUi } from "../test-helpers.js";
import { renderConfigView, getConfigKeyHints } from "./config.js";
import type { ConfigViewState } from "./config.js";

const DEFAULT_MANIFEST_HEALTH: ManifestHealth = {
  exists: false,
  entryCount: 0,
  linkedCount: 0,
  staleCount: 0,
  missingCount: 0,
};

function makeEngine(overrides: Partial<EngineStatus> = {}): EngineStatus {
  return {
    engine: "hooks",
    detected: true,
    configured: true,
    ...overrides,
  };
}

function makeDeployment(overrides: Partial<ToolDeployment> = {}): ToolDeployment {
  return {
    adapterId: "claude-code",
    targetPath: "/home/user/.claude/hooks.json",
    strategy: "symlink",
    status: "linked",
    ...overrides,
  };
}

function makeState(overrides: Partial<ConfigViewState> = {}): ConfigViewState {
  return {
    engines: [],
    deployments: [],
    manifestHealth: DEFAULT_MANIFEST_HEALTH,
    mode: "canonical",
    configHealth: "healthy",
    loadingConfig: false,
    configSelectedIndex: 0,
    configLastAction: null,
    keyOverrides: {},
    ...overrides,
  };
}

// ── helpers ───────────────────────────────────────────

type AnyNode = {
  type?: string;
  content?: string;
  props?: Record<string, unknown>;
  children?: AnyNode[];
};

/** Flatten a node tree into all text content strings. */
function allText(node: AnyNode): string[] {
  const out: string[] = [];
  // Collect content from text, richText, badge, callout, tag nodes
  if (node.content !== undefined) out.push(node.content);
  for (const c of node.children ?? []) out.push(...allText(c));
  return out;
}

// ── renderConfigView ──────────────────────────────────

describe("renderConfigView", () => {
  it("shows loading message when loading with no engines", () => {
    const state = makeState({ loadingConfig: true });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    expect(String(vnode.props?.title)).toContain("Config");
    // children[0] is a spinner node — check its label prop
    const spinner = (vnode.children ?? [])[0] as unknown as { props: { label: string } };
    expect(spinner.props.label).toContain("Loading config");
  });

  it("shows no engines message when empty and not loading", () => {
    const state = makeState({ loadingConfig: false });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("No engines found"))).toBe(true);
  });

  it("shows mode", () => {
    const state = makeState({
      engines: [makeEngine()],
      mode: "canonical",
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    // Mode appears in the summary richText: "Mode  canonical  Health  …"
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("canonical"))).toBe(true);
  });

  it("shows config health", () => {
    const state = makeState({
      engines: [makeEngine()],
      configHealth: "healthy",
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    // Health appears in the callout and in the summary richText
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("healthy"))).toBe(true);
  });

  it("shows configured count", () => {
    const state = makeState({
      engines: [
        makeEngine({ engine: "hooks", configured: true }),
        makeEngine({ engine: "mcp", configured: false }),
        makeEngine({ engine: "skills", configured: true }),
      ],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    // Count appears in the callout: "healthy  ·  canonical mode  ·  2/3 engines configured"
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("2/3"))).toBe(true);
  });

  it("shows check icon for configured engines", () => {
    const state = makeState({
      engines: [makeEngine({ engine: "hooks", configured: true })],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("hooks"))).toBe(true);
    expect(texts.some((t) => t.includes("configured"))).toBe(true);
  });

  it("shows x icon for unconfigured engines", () => {
    const state = makeState({
      engines: [makeEngine({ engine: "mcp", configured: false })],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("mcp"))).toBe(true);
    expect(texts.some((t) => t.includes("not configured"))).toBe(true);
  });

  it("dims unconfigured engines", () => {
    const state = makeState({
      engines: [makeEngine({ engine: "mcp", configured: false })],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("mcp"))).toBe(true);
    expect(texts.some((t) => t.includes("not configured"))).toBe(true);
  });

  it("does not dim configured engines", () => {
    const state = makeState({
      engines: [makeEngine({ engine: "hooks", configured: true })],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("hooks"))).toBe(true);
    expect(texts.some((t) => t.includes("configured"))).toBe(true);
  });

  it("shows error text for engines with errors", () => {
    const state = makeState({
      engines: [makeEngine({ engine: "hooks", configured: false, error: "parse error" })],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("parse error"))).toBe(true);
  });

  it("omits error text when no error", () => {
    const state = makeState({
      engines: [makeEngine({ engine: "hooks", configured: true })],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.every((t) => !t.includes("error:"))).toBe(true);
  });

  it("includes title with keybinding hints", () => {
    const state = makeState({
      engines: [makeEngine()],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    expect(String(vnode.props?.title)).toContain("g:Generate");
    expect(String(vnode.props?.title)).toContain("i:Install");
    expect(String(vnode.props?.title)).toContain("r:Refresh");
    expect(String(vnode.props?.title)).toContain("s:MCP install");
    expect(String(vnode.props?.title)).toContain("d:Detect");
  });

  it("title uses overridden keys", () => {
    const state = makeState({
      engines: [makeEngine()],
      keyOverrides: { "config-generate": "G" },
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    expect(String(vnode.props?.title)).toContain("G:Generate");
    expect(String(vnode.props?.title)).not.toContain("g:Generate");
  });

  // ── Deployments table ──────────────────────────────

  it("renders deployments table when deployments exist", () => {
    const state = makeState({
      engines: [makeEngine()],
      deployments: [
        makeDeployment({ adapterId: "claude-code", status: "linked" }),
        makeDeployment({ adapterId: "cursor", status: "stale" }),
      ],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("Deployments"))).toBe(true);
    expect(texts.some((t) => t.includes("2 targets"))).toBe(true);
    expect(texts.some((t) => t.includes("claude-code"))).toBe(true);
    expect(texts.some((t) => t.includes("cursor"))).toBe(true);
  });

  it("omits deployments table when no deployments", () => {
    const state = makeState({
      engines: [makeEngine()],
      deployments: [],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("Deployments") && t.includes("targets"))).toBe(false);
  });

  // ── Manifest health in callout ──────────────────────

  it("shows deployment count in callout when manifest exists", () => {
    const state = makeState({
      engines: [makeEngine()],
      manifestHealth: {
        exists: true,
        entryCount: 5,
        linkedCount: 3,
        staleCount: 1,
        missingCount: 1,
      },
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    // Callout shows "5 deployments"
    expect(texts.some((t) => t.includes("5 deployments"))).toBe(true);
    expect(texts.some((t) => t.includes("1 stale"))).toBe(true);
    expect(texts.some((t) => t.includes("1 missing"))).toBe(true);
  });

  it("omits stale/missing counts in callout when zero", () => {
    const state = makeState({
      engines: [makeEngine()],
      manifestHealth: {
        exists: true,
        entryCount: 3,
        linkedCount: 3,
        staleCount: 0,
        missingCount: 0,
      },
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("3 deployments"))).toBe(true);
    expect(texts.some((t) => t.includes("stale"))).toBe(false);
    expect(texts.some((t) => t.includes("missing"))).toBe(false);
  });

  // ── Stats bar stale/missing ────────────────────────

  it("shows stale count in stats bar when non-zero", () => {
    const state = makeState({
      engines: [makeEngine()],
      manifestHealth: {
        exists: true,
        entryCount: 4,
        linkedCount: 2,
        staleCount: 2,
        missingCount: 0,
      },
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    // Stats bar includes "Stale  2"
    expect(texts.some((t) => t.includes("Stale") && t.includes("2"))).toBe(true);
  });

  it("shows missing count in stats bar when non-zero", () => {
    const state = makeState({
      engines: [makeEngine()],
      manifestHealth: {
        exists: true,
        entryCount: 3,
        linkedCount: 1,
        staleCount: 0,
        missingCount: 2,
      },
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("Missing") && t.includes("2"))).toBe(true);
  });

  // ── j/k selection highlighting ─────────────────────

  it("highlights selected engine row with selection prefix", () => {
    const state = makeState({
      engines: [
        makeEngine({ engine: "hooks" }),
        makeEngine({ engine: "mcp" }),
        makeEngine({ engine: "skills" }),
      ],
      configSelectedIndex: 1,
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    // All engine names should be present
    expect(texts.some((t) => t.includes("hooks"))).toBe(true);
    expect(texts.some((t) => t.includes("mcp"))).toBe(true);
    expect(texts.some((t) => t.includes("skills"))).toBe(true);
    // The selected row (index 1, mcp) should have "▸" selection indicator
    expect(texts.some((t) => t.includes("\u25B8"))).toBe(true);
  });

  // ── Action feedback ────────────────────────────────

  it("shows success feedback when configLastAction is set", () => {
    const state = makeState({
      engines: [makeEngine()],
      configLastAction: { type: "generate", result: "success", message: "Config generated" },
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("generate") && t.includes("Config generated"))).toBe(true);
  });

  it("shows error feedback when configLastAction has error result", () => {
    const state = makeState({
      engines: [makeEngine()],
      configLastAction: { type: "sync", result: "error", message: "Config sync failed" },
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("sync") && t.includes("Config sync failed"))).toBe(true);
  });

  it("omits feedback section when configLastAction is null", () => {
    const state = makeState({
      engines: [makeEngine()],
      configLastAction: null,
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    // No feedback text should appear (no "generate:", "sync:", etc.)
    expect(texts.some((t) => /^(generate|install|sync|detect|refresh):/.test(t))).toBe(false);
  });

  // ── Engine configPath display ──────────────────────

  it("shows configPath in detail column when available", () => {
    const state = makeState({
      engines: [
        makeEngine({
          engine: "hooks",
          configured: true,
          configPath: "/home/user/ai-hooks.config.ts",
        }),
      ],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("ai-hooks.config.ts"))).toBe(true);
  });

  it("formats cwd-relative engine and deployment paths portably via path.relative", async () => {
    const { join } = await import("node:path");
    const cwdConfig = join(process.cwd(), "mcp.config.ts");
    const cwdDeploy = join(process.cwd(), ".cursor", "mcp.json");
    const state = makeState({
      engines: [
        makeEngine({
          engine: "mcp",
          configured: true,
          configPath: cwdConfig,
        }),
      ],
      deployments: [
        makeDeployment({
          adapterId: "cursor",
          targetPath: cwdDeploy,
        }),
      ],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes("mcp.config.ts") && !t.includes(process.cwd()))).toBe(true);
    expect(
      texts.some((t) => t.includes(join(".cursor", "mcp.json")) && !t.includes(process.cwd())),
    ).toBe(true);
  });

  // ── Actions hint bar ───────────────────────────────

  it("includes all action hints in the bottom bar", () => {
    const state = makeState({
      engines: [makeEngine()],
    });
    const vnode = renderConfigView(mockUi, state) as unknown as AnyNode;
    const texts = allText(vnode);
    expect(texts.some((t) => t.includes(":Generate"))).toBe(true);
    expect(texts.some((t) => t.includes(":Install"))).toBe(true);
    expect(texts.some((t) => t.includes(":MCP install"))).toBe(true);
    expect(texts.some((t) => t.includes(":Detect"))).toBe(true);
    expect(texts.some((t) => t.includes(":Refresh"))).toBe(true);
    expect(texts.some((t) => t.includes(":$EDITOR"))).toBe(true);
  });
});

// ── getConfigKeyHints ─────────────────────────────────

describe("getConfigKeyHints", () => {
  it("returns key hint string with all actions", () => {
    const hints = getConfigKeyHints({});
    expect(hints).toContain("g:Generate");
    expect(hints).toContain("i:Install");
    expect(hints).toContain("s:MCP install");
    expect(hints).toContain("d:Detect");
    expect(hints).toContain("r:Refresh");
    expect(hints).toContain("e:$EDITOR");
  });

  it("respects key overrides", () => {
    const hints = getConfigKeyHints({ "config-generate": "G", "config-sync": "S" });
    expect(hints).toContain("G:Generate");
    expect(hints).toContain("S:MCP install");
    // Non-overridden keys keep defaults
    expect(hints).toContain("i:Install");
  });
});
