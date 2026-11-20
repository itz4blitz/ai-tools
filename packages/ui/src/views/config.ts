import { isAbsolute, relative } from "node:path";
import type { UiKit } from "../types.js";
import type { EngineStatus, ToolDeployment, ManifestHealth } from "../widgets/config-dashboard.js";
import type { ConfigLastAction } from "../runtime/state.js";
import {
  BRAND,
  STATUS,
  SURFACE,
  TEXT,
  tintBg,
  getIconChar,
  PADDING,
  GAP,
  PRESETS,
  TINT,
} from "../theme.js";
import {
  fitText,
  renderEmptyState,
  renderActionHints,
  renderColumnHeaders,
  computeConfigColumnWidths,
  resolveHints,
  resolveKeyHint,
  GUTTER_SELECTED,
  GUTTER_UNSELECTED,
} from "./utils.js";

export type ConfigViewState = {
  engines: EngineStatus[];
  deployments: ToolDeployment[];
  manifestHealth: ManifestHealth;
  mode: string;
  configHealth: string;
  loadingConfig: boolean;
  configSelectedIndex: number;
  configLastAction: ConfigLastAction | null;
  keyOverrides: Record<string, string>;
};

function formatRelativePath(targetPath: string): string {
  const rel = relative(process.cwd(), targetPath);
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return targetPath;
  return rel;
}

function hColor(health: string): { r: number; g: number; b: number } {
  const h = health.toLowerCase();
  if (h === "healthy" || h === "ok") return STATUS.success;
  if (h === "stale" || h === "warning") return STATUS.warning;
  if (h === "error" || h === "unhealthy") return STATUS.error;
  return STATUS.neutral;
}

function hCalloutVariant(health: string): string {
  const h = health.toLowerCase();
  if (h === "healthy" || h === "ok") return "success";
  if (h === "stale" || h === "warning") return "warning";
  if (h === "error" || h === "unhealthy") return "error";
  return "info";
}

function deploymentStatusColor(status: ToolDeployment["status"]): {
  r: number;
  g: number;
  b: number;
} {
  switch (status) {
    case "linked":
    case "direct":
      return STATUS.success;
    case "stale":
      return STATUS.warning;
    case "missing":
      return STATUS.error;
  }
}

function buildConfigTitle(overrides: Record<string, string>): string {
  const g = resolveKeyHint("config-generate", overrides, "g");
  const i = resolveKeyHint("config-install", overrides, "i");
  const s = resolveKeyHint("config-sync", overrides, "s");
  const d = resolveKeyHint("config-detect", overrides, "d");
  const r = resolveKeyHint("config-refresh", overrides, "r");
  return `  ${getIconChar("nav.config")} Config  [${g}:Generate  ${i}:Install  ${s}:MCP install  ${d}:Detect  ${r}:Refresh]  `;
}

/**
 * Render the config dashboard.
 */
export function renderConfigView<T>(ui: UiKit<T>, state: ConfigViewState): T {
  const title = buildConfigTitle(state.keyOverrides);

  // ── Loading state ───────────────────────────
  if (state.loadingConfig) {
    return ui.box({ ...PRESETS.content, title, style: { bg: SURFACE.base } }, [
      ui.spinner({ variant: "dots", label: "Loading config…" }),
    ]);
  }

  // ── Empty state ───────────────────────────
  const genKey = resolveKeyHint("config-generate", state.keyOverrides, "g");
  const instKey = resolveKeyHint("config-install", state.keyOverrides, "i");
  if (state.engines.length === 0) {
    return ui.box({ ...PRESETS.content, title, style: { bg: SURFACE.base } }, [
      renderEmptyState(ui, getIconChar("nav.config"), "No engines found", [
        { text: "Ensure your AI tools are installed and configuration files exist." },
        {
          spans: [
            { text: "Press ", style: { fg: TEXT.tertiary } },
            { text: genKey, style: { fg: BRAND.accent, bold: true } },
            { text: " to generate config or ", style: { fg: TEXT.tertiary } },
            { text: instKey, style: { fg: BRAND.accent, bold: true } },
            { text: " to install engines.", style: { fg: TEXT.tertiary } },
          ],
        },
      ]),
    ]);
  }

  const configuredCount = state.engines.filter((e) => e.configured).length;
  const total = state.engines.length;
  const health = state.configHealth;
  const color = hColor(health);
  const calloutVariant = hCalloutVariant(health);
  const mh = state.manifestHealth;

  // ── Health summary callout ──────────────────────────
  const calloutParts = [
    `${health}  ·  ${state.mode} mode  ·  ${configuredCount}/${total} engines configured`,
  ];
  if (mh.exists) {
    calloutParts.push(`  ·  ${mh.entryCount} deployments`);
    if (mh.staleCount > 0) calloutParts.push(` (${mh.staleCount} stale)`);
    if (mh.missingCount > 0) calloutParts.push(` (${mh.missingCount} missing)`);
  }
  const healthCallout = ui.callout(calloutParts.join(""), { variant: calloutVariant });

  const { engine: colEngine, status: colStatus, detail: colDetail } = computeConfigColumnWidths();

  // ── Stats bar ──────────────────────────────────────
  const statsSpans: { text: string; style: Record<string, unknown> }[] = [
    { text: "Mode  ", style: { fg: STATUS.neutral } },
    { text: state.mode, style: { fg: STATUS.info, bold: true } },
    { text: " │ Health  ", style: { fg: STATUS.neutral } },
    { text: health, style: { fg: color, bold: true } },
    { text: " │ Engines  ", style: { fg: STATUS.neutral } },
    {
      text: `${configuredCount}/${total}`,
      style: {
        fg: configuredCount === total ? STATUS.success : STATUS.warning,
        bold: true,
      },
    },
    { text: " │ Deployments  ", style: { fg: STATUS.neutral } },
    { text: `${mh.entryCount}`, style: { fg: TEXT.primary, bold: true } },
  ];
  if (mh.staleCount > 0) {
    statsSpans.push(
      { text: " │ Stale  ", style: { fg: STATUS.neutral } },
      { text: `${mh.staleCount}`, style: { fg: STATUS.warning, bold: true } },
    );
  }
  if (mh.missingCount > 0) {
    statsSpans.push(
      { text: " │ Missing  ", style: { fg: STATUS.neutral } },
      { text: `${mh.missingCount}`, style: { fg: STATUS.error, bold: true } },
    );
  }
  const summary = ui.richText(statsSpans);

  const tableHeader = renderColumnHeaders(ui, [
    { text: "Engine", width: colEngine },
    { text: "Status", width: colStatus },
    { text: "Detail", width: colDetail },
  ]);

  // ── Per-engine rows with j/k selection highlighting ───────────
  const engineRows: T[] = state.engines.map((e, index) => {
    const isSelected = index === state.configSelectedIndex;
    const dotColor = e.configured ? STATUS.success : e.error ? STATUS.error : TEXT.tertiary;
    const statusText = e.configured ? "configured" : e.error ? "error" : "not configured";
    const detailText = e.configPath
      ? formatRelativePath(e.configPath)
      : e.error
        ? `error: ${e.error}`
        : e.configured
          ? "ready"
          : "not configured";
    const isOdd = index % 2 === 1;
    const rowBg = isSelected
      ? tintBg(BRAND.accent, TINT.emphasis)
      : e.configured
        ? tintBg(STATUS.success, isOdd ? 0.06 : 0.03)
        : isOdd
          ? SURFACE.elevated
          : SURFACE.base;
    const statusIcon = e.configured
      ? getIconChar("status.success")
      : e.error
        ? getIconChar("status.error")
        : getIconChar("status.inactive");
    const gutterColor = isSelected ? BRAND.accent : SURFACE.base;

    return ui.box({ style: { bg: rowBg } }, [
      ui.richText([
        {
          text: isSelected ? GUTTER_SELECTED : GUTTER_UNSELECTED,
          style: { fg: gutterColor, bg: rowBg, bold: true },
        },
        {
          text: fitText(`${statusIcon} ${e.engine}`, colEngine),
          style: {
            fg: e.configured ? BRAND.base : TEXT.secondary,
            bg: rowBg,
            bold: e.configured || isSelected,
          },
        },
        { text: " \u2502 ", style: { fg: TEXT.tertiary, bg: rowBg } },
        {
          text: fitText(statusText, colStatus),
          style: { fg: dotColor, bg: rowBg, bold: e.configured || Boolean(e.error) },
        },
        { text: " \u2502 ", style: { fg: TEXT.tertiary, bg: rowBg } },
        {
          text: fitText(detailText, colDetail),
          style: { fg: e.configured ? STATUS.neutral : TEXT.tertiary, bg: rowBg },
        },
      ]),
    ]);
  });

  // ── Deployments table (canonical mode) ────────────────────
  const deploymentsSection: T[] = [];
  if (state.deployments.length > 0) {
    const deployContentWidth = Math.max(70, (process.stdout.columns ?? 120) - 36);
    const colAdapter = Math.max(16, Math.floor(deployContentWidth * 0.2));
    const colTarget = Math.max(30, Math.floor(deployContentWidth * 0.4));
    const colStrategy = Math.max(12, Math.floor(deployContentWidth * 0.15));
    const colDeployStatus = Math.max(
      10,
      deployContentWidth - colAdapter - colTarget - colStrategy - 10,
    );

    deploymentsSection.push(
      ui.divider(),
      ui.richText([
        { text: "Deployments", style: { fg: BRAND.base, bold: true } },
        {
          text: `  (${state.deployments.length} targets)`,
          style: { fg: TEXT.tertiary },
        },
      ]),
      ui.richText([
        { text: "  " },
        { text: fitText("Adapter", colAdapter), style: { fg: BRAND.base, bold: true } },
        { text: " │ ", style: { fg: TEXT.tertiary } },
        { text: fitText("Target", colTarget), style: { fg: BRAND.base, bold: true } },
        { text: " │ ", style: { fg: TEXT.tertiary } },
        { text: fitText("Strategy", colStrategy), style: { fg: BRAND.base, bold: true } },
        { text: " │ ", style: { fg: TEXT.tertiary } },
        { text: fitText("Status", colDeployStatus), style: { fg: BRAND.base, bold: true } },
      ]),
      ui.divider({ char: "─" }),
    );

    const deployRows: T[] = state.deployments.map((d, index) => {
      const isOdd = index % 2 === 1;
      const dColor = deploymentStatusColor(d.status);
      const rowBg = isOdd ? SURFACE.elevated : SURFACE.base;
      const statusIcon =
        d.status === "linked" || d.status === "direct"
          ? getIconChar("status.success")
          : d.status === "stale"
            ? getIconChar("status.stale")
            : getIconChar("status.error");
      const shortTarget = formatRelativePath(d.targetPath);

      return ui.box({ style: { bg: rowBg } }, [
        ui.richText([
          { text: "  ", style: { bg: rowBg } },
          {
            text: fitText(d.adapterId, colAdapter),
            style: { fg: TEXT.primary, bg: rowBg },
          },
          { text: " \u2502 ", style: { fg: TEXT.tertiary, bg: rowBg } },
          {
            text: fitText(shortTarget, colTarget),
            style: { fg: TEXT.secondary, bg: rowBg },
          },
          { text: " \u2502 ", style: { fg: TEXT.tertiary, bg: rowBg } },
          {
            text: fitText(d.strategy, colStrategy),
            style: { fg: TEXT.tertiary, bg: rowBg },
          },
          { text: " \u2502 ", style: { fg: TEXT.tertiary, bg: rowBg } },
          {
            text: fitText(`${statusIcon} ${d.status}`, colDeployStatus),
            style: { fg: dColor, bg: rowBg, bold: true },
          },
        ]),
      ]);
    });
    deploymentsSection.push(ui.column({ gap: GAP.none }, deployRows));
  }

  // ── Action feedback ────────────────────────────────
  const feedbackSection: T[] = [];
  if (state.configLastAction) {
    const feedbackColor =
      state.configLastAction.result === "success" ? STATUS.success : STATUS.error;
    const feedbackIcon =
      state.configLastAction.result === "success"
        ? getIconChar("status.success")
        : getIconChar("status.error");
    feedbackSection.push(
      ui.richText([
        { text: ` ${feedbackIcon} `, style: { fg: feedbackColor, bold: true } },
        {
          text: `${state.configLastAction.type}: ${state.configLastAction.message}`,
          style: { fg: feedbackColor },
        },
      ]),
    );
  }

  // ── Actions hint ────────────────────────────────────
  const actionsHint = renderActionHints(
    ui,
    resolveHints(
      [
        ["config-generate", "Generate", "g"],
        ["config-install", "Install", "i"],
        ["config-sync", "MCP install", "s"],
        ["config-detect", "Detect", "d"],
        ["config-refresh", "Refresh", "r"],
        ["config-editor", "$EDITOR", "e"],
      ],
      state.keyOverrides,
    ),
  );

  return ui.box(
    {
      border: PRESETS.content.border,
      title,
      p: PADDING.card,
      flex: 1,
      style: { bg: SURFACE.base },
    },
    [
      ui.column({ gap: GAP.standard }, [
        healthCallout,
        summary,
        ui.divider(),
        ui.richText([
          { text: "Engine Status", style: { fg: BRAND.base, bold: true } },
          {
            text: `  (${configuredCount} of ${total} configured)`,
            style: { fg: TEXT.tertiary },
          },
        ]),
        tableHeader,
        ui.divider({ char: "─" }),
        ui.column({ gap: GAP.none }, engineRows),
        ...deploymentsSection,
        ...feedbackSection,
        ui.divider(),
        actionsHint,
      ]),
    ],
  );
}

export function getConfigKeyHints(overrides: Record<string, string>): string {
  return resolveHints(
    [
      ["config-generate", "Generate", "g"],
      ["config-install", "Install", "i"],
      ["config-sync", "MCP install", "s"],
      ["config-detect", "Detect", "d"],
      ["config-refresh", "Refresh", "r"],
      ["config-editor", "$EDITOR", "e"],
    ],
    overrides,
  )
    .map(([k, l]) => `${k}:${l}`)
    .join("  ");
}
