import { HANDOFF_TARGETS as SHARED_HANDOFF_TARGETS } from "@itz4blitz/ai-tools-sessions";
import type { UiKit } from "../types.js";
import type { SessionRow } from "../widgets/session-browser.js";
import {
  BRAND,
  STATUS,
  SURFACE,
  TEXT,
  COLOR_SEPARATOR,
  dimColor,
  tintBg,
  getIconChar,
  getToolIcon,
  getToolColor,
  PADDING,
  GAP,
  PRESETS,
  TINT,
} from "../theme.js";
import {
  computeSessionColumnWidths,
  renderSessionRow,
  renderEmptyState,
  renderColumnHeaders,
  renderActionHints,
  GUTTER_SELECTED,
  GUTTER_UNSELECTED,
} from "./utils.js";

export type HandoffViewState = {
  sessions: SessionRow[];
  loadingSessions: boolean;
  handoffStep: number;
  handoffSessionId: string | null;
  handoffTargetTool: string | null;
  handoffPreview: string | null;
  selectedSessionIndex: number;
  selectedTargetIndex: number;
  keyOverrides: Record<string, string>;
};

type HandoffTarget = { id: string; name: string };

const HANDOFF_TARGETS: HandoffTarget[] = SHARED_HANDOFF_TARGETS.map(({ id, name }) => ({
  id,
  name,
}));

/**
 * Render a rich step-progress indicator as a richText row.
 *
 *   ✓ Source  ──  ▶ Preview  ──  ○ Target  ──  ○ Confirm
 */
function renderStepProgress<T>(ui: Pick<UiKit<T>, "richText">, current: number): T {
  const steps = ["Source", "Preview", "Target", "Confirm"];
  const spans: Array<{ text: string; style?: Record<string, unknown> }> = [];

  steps.forEach((label, i) => {
    if (i > 0) {
      spans.push({ text: "  ──  ", style: { fg: COLOR_SEPARATOR } });
    }
    if (i < current) {
      spans.push({
        text: `${getIconChar("status.success")} `,
        style: { fg: STATUS.success, bold: true },
      });
      spans.push({ text: label, style: { fg: TEXT.tertiary } });
    } else if (i === current) {
      spans.push({
        text: `${getIconChar("status.running")} `,
        style: { fg: BRAND.accent, bold: true },
      });
      spans.push({ text: label, style: { fg: TEXT.primary, bold: true } });
    } else {
      spans.push({ text: `${getIconChar("status.pending")} `, style: { fg: COLOR_SEPARATOR } });
      spans.push({ text: label, style: { fg: COLOR_SEPARATOR } });
    }
  });

  return ui.richText(spans);
}

/**
 * Render the handoff wizard view.
 */
export function renderHandoffView<T>(ui: UiKit<T>, state: HandoffViewState): T {
  const stepLabel = `Step ${state.handoffStep + 1} of 4`;
  const title = `Handoff Wizard  (${stepLabel})`;

  switch (state.handoffStep) {
    case 0:
      return renderSessionSelectStep(ui, state, title);
    case 1:
      return renderPreviewStep(ui, state, title);
    case 2:
      return renderTargetSelectStep(ui, state, title);
    case 3:
      return renderConfirmStep(ui, state, title);
    default:
      return renderSessionSelectStep(ui, state, title);
  }
}

function renderSessionSelectStep<T>(ui: UiKit<T>, state: HandoffViewState, title: string): T {
  // ── Loading state ───────────────────────────
  if (state.loadingSessions) {
    return ui.box({ ...PRESETS.content, title, style: { bg: SURFACE.base } }, [
      ui.column({ gap: GAP.tight }, [
        renderStepProgress(ui, 0),
        ui.divider({ char: "─" }),
        ui.spinner({ variant: "dots", label: "  Loading sessions…" }),
      ]),
    ]);
  }

  // ── Empty state (after loading completes) ───────────────────────────
  if (state.sessions.length === 0) {
    return ui.box({ ...PRESETS.content, title, style: { bg: SURFACE.base } }, [
      ui.column({ gap: GAP.tight }, [
        renderStepProgress(ui, 0),
        ui.divider({ char: "─" }),
        renderEmptyState(ui, getIconChar("nav.sessions"), "No sessions available for handoff", [
          { text: "Create a session in an AI tool first, then return here." },
          {
            spans: [
              { text: "Press ", style: { fg: TEXT.tertiary } },
              { text: "Esc", style: { fg: BRAND.accent, bold: true } },
              { text: " to go back and start a session.", style: { fg: TEXT.tertiary } },
            ],
          },
        ]),
      ]),
    ]);
  }

  const cols = computeSessionColumnWidths();
  const header = renderColumnHeaders(ui, [
    { text: "Tool", width: cols.tool },
    { text: "Title", width: cols.title },
    { text: "Msgs", width: cols.msgs, align: "right" },
    { text: "Updated", width: cols.updated, align: "right" },
  ]);

  const rows = state.sessions.map((s, i) =>
    renderSessionRow(ui, s, i, state.selectedSessionIndex, cols),
  );

  return ui.box(
    { border: PRESETS.card.border, title, p: PADDING.card, flex: 1, style: { bg: SURFACE.base } },
    [
      ui.column({ gap: GAP.tight }, [
        renderStepProgress(ui, 0),
        ui.divider({ char: "─" }),
        ui.text("Select a session to hand off:", { bold: true, style: { fg: TEXT.primary } }),
        header,
        ui.divider({ char: "─" }),
        ...rows,
        ui.text(""),
        renderActionHints(ui, [
          ["Enter", "Select"],
          ["Esc", "Cancel"],
        ]),
      ]),
    ],
  );
}

function renderPreviewStep<T>(ui: UiKit<T>, state: HandoffViewState, title: string): T {
  const isLoading = state.handoffPreview === null;
  const preview = state.handoffPreview ?? "Loading handoff preview...";
  // Reserve rows for chrome (step progress, dividers, headings, action hints) and
  // use remaining terminal height for preview content.
  const maxPreviewLines = Math.max(6, (process.stdout.rows ?? 30) - 14);
  const allLines = preview.split("\n");
  const truncated = allLines.length > maxPreviewLines;
  const previewLines =
    allLines.slice(0, maxPreviewLines).join("\n") + (truncated ? "\n\u2026" : "");
  const previewBg = SURFACE.elevated;

  const headerSpans: Array<{ text: string; style?: Record<string, unknown> }> = [
    {
      text: `${getIconChar("nav.handoff")} `,
      style: { fg: BRAND.accent, bold: true },
    },
    { text: "Handoff Context Preview", style: { fg: TEXT.primary, bold: true } },
  ];
  if (!isLoading) {
    headerSpans.push({
      text: `  (${allLines.length} lines${truncated ? ", truncated" : ""})`,
      style: { fg: TEXT.tertiary },
    });
  }

  return ui.box(
    { border: PRESETS.card.border, title, p: PADDING.card, flex: 1, style: { bg: SURFACE.base } },
    [
      ui.column({ gap: GAP.tight }, [
        renderStepProgress(ui, 1),
        ui.divider({ char: "─" }),
        ui.richText(headerSpans),
        ui.text("Review what will be transferred before selecting a target.", {
          style: { fg: TEXT.tertiary },
        }),
        ui.box({ style: { bg: previewBg }, p: PADDING.card }, [
          isLoading
            ? ui.spinner({ variant: "dots", label: "  Generating context summary…" })
            : ui.text(previewLines, { style: { fg: TEXT.secondary } }),
        ]),
        ui.text(""),
        renderActionHints(ui, [
          ["Enter", "Continue"],
          ["Esc", "Back"],
        ]),
      ]),
    ],
  );
}

function renderTargetSelectStep<T>(ui: UiKit<T>, state: HandoffViewState, title: string): T {
  const rows = HANDOFF_TARGETS.map((target, i) => {
    const selected = i === state.selectedTargetIndex;
    const icon = getIconChar(getToolIcon(target.id));
    const color = getToolColor(target.id);
    const rowBg = selected
      ? tintBg(color, TINT.emphasis)
      : i % 2 === 1
        ? SURFACE.elevated
        : SURFACE.base;
    const gutterColor = selected ? color : dimColor(color, 0.25);

    return ui.box({ style: { bg: rowBg } }, [
      ui.richText([
        {
          text: selected ? GUTTER_SELECTED : GUTTER_UNSELECTED,
          style: { fg: gutterColor, bold: selected, bg: rowBg },
        },
        {
          text: `${icon} `,
          style: { fg: selected ? color : dimColor(color, 0.65), bold: selected, bg: rowBg },
        },
        {
          text: target.name,
          style: { fg: selected ? TEXT.primary : STATUS.neutral, bold: selected, bg: rowBg },
        },
      ]),
    ]);
  });

  return ui.box(
    { border: PRESETS.card.border, title, p: PADDING.card, flex: 1, style: { bg: SURFACE.base } },
    [
      ui.column({ gap: GAP.tight }, [
        renderStepProgress(ui, 2),
        ui.divider({ char: "─" }),
        ui.text("Select target tool:", { bold: true, style: { fg: TEXT.primary } }),
        ui.text("Pick where to continue this conversation.", { style: { fg: TEXT.tertiary } }),
        ...rows,
        ui.text(""),
        renderActionHints(ui, [
          ["Enter", "Select"],
          ["Esc", "Back"],
        ]),
      ]),
    ],
  );
}

function renderConfirmStep<T>(ui: UiKit<T>, state: HandoffViewState, title: string): T {
  const session = state.sessions.find((s) => s.id === state.handoffSessionId);
  const target = HANDOFF_TARGETS[state.selectedTargetIndex];
  const sessionTitle = session?.title ?? "Unknown";
  const sessionTool = session?.tool ?? "";
  const targetName = target?.name ?? "Unknown";
  const targetId = target?.id ?? "";
  const sourceColor = sessionTool ? getToolColor(sessionTool) : STATUS.warning;
  const targetColor = targetId ? getToolColor(targetId) : STATUS.success;
  const sourceIcon = sessionTool ? getIconChar(getToolIcon(sessionTool)) : "";
  const targetIcon = targetId ? getIconChar(getToolIcon(targetId)) : "";
  const confirmBg = tintBg(BRAND.base, 0.08);
  const transferBg = SURFACE.elevated;

  return ui.box(
    { border: PRESETS.card.border, title, p: PADDING.card, flex: 1, style: { bg: confirmBg } },
    [
      ui.column({ gap: GAP.tight }, [
        renderStepProgress(ui, 3),
        ui.divider({ char: "─" }),
        ui.text("Confirm Handoff:", { bold: true, style: { fg: TEXT.primary } }),
        ui.text("Review and confirm the session transfer below.", {
          style: { fg: TEXT.tertiary },
        }),
        ui.text(""),
        ui.box({ style: { bg: transferBg }, p: PADDING.card }, [
          ui.column({ gap: GAP.tight }, [
            ui.richText([
              { text: "From:  ", style: { fg: TEXT.tertiary, bg: transferBg } },
              {
                text: sourceIcon ? `${sourceIcon} ` : "",
                style: { fg: sourceColor, bold: true, bg: transferBg },
              },
              { text: sessionTitle, style: { fg: sourceColor, bold: true, bg: transferBg } },
            ]),
            ui.richText([
              {
                text: `  ${getIconChar("nav.handoff")} `,
                style: { fg: BRAND.accent, bold: true, bg: transferBg },
              },
            ]),
            ui.richText([
              { text: "To:    ", style: { fg: TEXT.tertiary, bg: transferBg } },
              {
                text: targetIcon ? `${targetIcon} ` : "",
                style: { fg: targetColor, bold: true, bg: transferBg },
              },
              { text: targetName, style: { fg: targetColor, bold: true, bg: transferBg } },
            ]),
          ]),
        ]),
        ui.text(""),
        renderActionHints(ui, [
          ["Enter", "Launch"],
          ["Esc", "Cancel"],
        ]),
      ]),
    ],
  );
}

/**
 * Get the list of handoff target tool IDs.
 */
export function getHandoffTargets(): HandoffTarget[] {
  return [...HANDOFF_TARGETS];
}

/**
 * Get the target tool ID at the given index.
 */
export function getTargetToolId(index: number): string | null {
  const target = HANDOFF_TARGETS[index];
  return target?.id ?? null;
}

/**
 * Get context-sensitive key hints for the handoff view.
 */
export function getHandoffKeyHints(overrides: Record<string, string>): string {
  void overrides;
  return "Enter:Next  Esc:Cancel  j/k:Select";
}
