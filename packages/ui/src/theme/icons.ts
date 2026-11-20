/**
 * Icon System for the ai-tools TUI
 *
 * Maps semantic icon names to Rezi's icon registry.
 * Provides type-safe icon access with fallback support.
 *
 * @see https://rezitui.dev/docs/styling/icons
 */

import type { RgbColor } from "../theme.js";
import { TOOLS, STATUS } from "./tokens.js";

// ─────────────────────────────────────────────────────────────
// ICON REGISTRY
// ─────────────────────────────────────────────────────────────

/**
 * Semantic icon names used throughout the application.
 * These map to Rezi's icon paths or provide custom fallbacks.
 */
export type IconName =
  // Status icons
  | "status.success"
  | "status.error"
  | "status.warning"
  | "status.info"
  | "status.pending"
  | "status.running"
  | "status.stopped"
  | "status.unknown"
  | "status.active"
  | "status.inactive"
  | "status.stale"
  // Navigation icons
  | "nav.tools"
  | "nav.sessions"
  | "nav.handoff"
  | "nav.config"
  | "nav.terminal"
  | "nav.back"
  | "nav.forward"
  | "nav.close"
  | "nav.menu"
  | "nav.settings"
  | "nav.help"
  // Action icons
  | "action.launch"
  | "action.kill"
  | "action.refresh"
  | "action.search"
  | "action.edit"
  | "action.save"
  | "action.copy"
  | "action.paste"
  | "action.undo"
  | "action.redo"
  | "action.settings"
  | "action.help"
  // Selection icons
  | "select.selected"
  | "select.unselected"
  | "select.collapsed"
  | "select.expanded"
  // Tool icons
  | "tool.claude"
  | "tool.codex"
  | "tool.gemini"
  | "tool.cursor"
  | "tool.opencode"
  | "tool.amp"
  | "tool.cline"
  | "tool.generic"
  // Brand icons
  | "brand.logo"
  | "brand.particle"
  // Session icons
  | "session.messages"
  | "session.time"
  | "session.folder"
  | "session.file"
  // Powerline/Decorative
  | "powerline.segment"
  | "powerline.separator"
  | "ui.bullet"
  | "ui.arrow.right"
  | "ui.arrow.left"
  | "ui.arrow.up"
  | "ui.arrow.down"
  | "ui.chevron.right"
  | "ui.chevron.left"
  | "ui.chevron.up"
  | "ui.chevron.down";

/**
 * Icon definition with primary glyph and ASCII fallback.
 */
export interface IconDef {
  /** Primary Unicode glyph */
  glyph: string;
  /** ASCII fallback for limited terminals */
  fallback: string;
  /** Display width in cells */
  width: number;
}

/**
 * Icon registry mapping semantic names to display characters.
 *
 * Note: This is our own registry that maps to Rezi's ui.icon() system
 * or provides direct glyphs for richText spans.
 */
export const ICONS: Record<IconName, IconDef> = {
  // Status icons
  "status.success": { glyph: "✓", fallback: "[x]", width: 1 },
  "status.error": { glyph: "✗", fallback: "[X]", width: 1 },
  "status.warning": { glyph: "⚠", fallback: "[!]", width: 2 },
  "status.info": { glyph: "ℹ", fallback: "[i]", width: 1 },
  "status.pending": { glyph: "○", fallback: "[ ]", width: 1 },
  "status.running": { glyph: "▶", fallback: ">", width: 1 },
  "status.stopped": { glyph: "■", fallback: "[]", width: 1 },
  "status.unknown": { glyph: "?", fallback: "[?]", width: 1 },
  "status.active": { glyph: "●", fallback: "[*]", width: 1 },
  "status.inactive": { glyph: "○", fallback: "[ ]", width: 1 },
  "status.stale": { glyph: "◐", fallback: "[~]", width: 1 },

  // Navigation icons
  "nav.tools": { glyph: "⚙", fallback: "[T]", width: 2 },
  "nav.sessions": { glyph: "◈", fallback: "[S]", width: 1 },
  "nav.handoff": { glyph: "⇄", fallback: "[H]", width: 1 },
  "nav.config": { glyph: "≡", fallback: "[C]", width: 1 },
  "nav.terminal": { glyph: "▸", fallback: ">", width: 1 },
  "nav.back": { glyph: "←", fallback: "<", width: 1 },
  "nav.forward": { glyph: "→", fallback: ">", width: 1 },
  "nav.close": { glyph: "×", fallback: "x", width: 1 },
  "nav.menu": { glyph: "☰", fallback: "=", width: 1 },
  "nav.settings": { glyph: "⚙", fallback: "[S]", width: 2 },
  "nav.help": { glyph: "ℹ", fallback: "?", width: 1 },

  // Action icons
  "action.launch": { glyph: "▶", fallback: ">", width: 1 },
  "action.kill": { glyph: "⏹", fallback: "[X]", width: 2 },
  "action.refresh": { glyph: "↻", fallback: "R", width: 1 },
  "action.search": { glyph: "⌕", fallback: "/", width: 1 },
  "action.edit": { glyph: "✎", fallback: "E", width: 1 },
  "action.save": { glyph: "💾", fallback: "S", width: 2 },
  "action.copy": { glyph: "⧉", fallback: "C", width: 1 },
  "action.paste": { glyph: "📋", fallback: "P", width: 2 },
  "action.undo": { glyph: "↶", fallback: "U", width: 1 },
  "action.redo": { glyph: "↷", fallback: "R", width: 1 },
  "action.settings": { glyph: "⚙", fallback: "*", width: 2 },
  "action.help": { glyph: "?", fallback: "?", width: 1 },

  // Selection icons
  "select.selected": { glyph: "▶", fallback: ">", width: 1 },
  "select.unselected": { glyph: " ", fallback: " ", width: 1 },
  "select.collapsed": { glyph: "▸", fallback: ">", width: 1 },
  "select.expanded": { glyph: "▾", fallback: "v", width: 1 },

  // Tool icons (custom symbols for each tool)
  "tool.claude": { glyph: "◉", fallback: "[@]", width: 1 },
  "tool.codex": { glyph: "◈", fallback: "[#]", width: 1 },
  "tool.gemini": { glyph: "✦", fallback: "[*]", width: 1 },
  "tool.cursor": { glyph: "⊡", fallback: "[C]", width: 1 },
  "tool.opencode": { glyph: "⬡", fallback: "[O]", width: 1 },
  "tool.amp": { glyph: "⚡", fallback: "[A]", width: 2 },
  "tool.cline": { glyph: "◎", fallback: "[L]", width: 1 },
  "tool.generic": { glyph: "◆", fallback: "[*]", width: 1 },

  // Brand icons
  "brand.logo": { glyph: "◆", fallback: "*", width: 1 },
  "brand.particle": { glyph: "◉", fallback: "o", width: 1 },

  // Session icons
  "session.messages": { glyph: "✉", fallback: "M", width: 2 },
  "session.time": { glyph: "◷", fallback: "T", width: 1 },
  "session.folder": { glyph: "▤", fallback: "[+]", width: 1 },
  "session.file": { glyph: "▥", fallback: "[f]", width: 1 },

  // Powerline/Decorative
  "powerline.segment": { glyph: "▐", fallback: "|", width: 1 },
  "powerline.separator": { glyph: "▌", fallback: "|", width: 1 },
  "ui.bullet": { glyph: "•", fallback: "*", width: 1 },
  "ui.arrow.right": { glyph: "→", fallback: ">", width: 1 },
  "ui.arrow.left": { glyph: "←", fallback: "<", width: 1 },
  "ui.arrow.up": { glyph: "↑", fallback: "^", width: 1 },
  "ui.arrow.down": { glyph: "↓", fallback: "v", width: 1 },
  "ui.chevron.right": { glyph: "▶", fallback: ">", width: 1 },
  "ui.chevron.left": { glyph: "◀", fallback: "<", width: 1 },
  "ui.chevron.up": { glyph: "▲", fallback: "^", width: 1 },
  "ui.chevron.down": { glyph: "▼", fallback: "v", width: 1 },
};

// ─────────────────────────────────────────────────────────────
// ICON HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Get an icon definition by name.
 */
export function getIcon(name: IconName): IconDef {
  return ICONS[name] ?? { glyph: "?", fallback: "[?]", width: 1 };
}

/**
 * Get the display character for an icon.
 * Automatically selects fallback for ASCII-only terminals if needed.
 */
export function getIconChar(name: IconName, useFallback = false): string {
  const icon = getIcon(name);
  return useFallback ? icon.fallback : icon.glyph;
}

const TOOL_ID_ALIASES: Record<string, string> = {
  "claude-code": "claude",
  "gemini-cli": "gemini",
};

function normalizeToolId(toolId: string): string {
  const lower = toolId.toLowerCase();
  return TOOL_ID_ALIASES[lower] ?? lower;
}

/**
 * Get the tool icon for a given tool ID.
 */
export function getToolIcon(toolId: string): IconName {
  const normalized = normalizeToolId(toolId);
  if (normalized.startsWith("claude")) return "tool.claude";
  if (normalized.startsWith("codex")) return "tool.codex";
  if (normalized.startsWith("gemini")) return "tool.gemini";
  if (normalized.startsWith("cursor")) return "tool.cursor";
  if (normalized.startsWith("opencode")) return "tool.opencode";
  if (normalized.startsWith("amp")) return "tool.amp";
  if (normalized.startsWith("cline")) return "tool.cline";
  return "tool.generic";
}

/**
 * Get the brand color for a given tool ID.
 */
export function getToolColor(toolId: string): RgbColor {
  const normalized = normalizeToolId(toolId);
  if (normalized.startsWith("claude")) return TOOLS.claude;
  if (normalized.startsWith("codex")) return TOOLS.codex;
  if (normalized.startsWith("gemini")) return TOOLS.gemini;
  if (normalized.startsWith("cursor")) return TOOLS.cursor;
  if (normalized.startsWith("opencode")) return TOOLS.opencode;
  if (normalized.startsWith("amp")) return TOOLS.amp;
  if (normalized.startsWith("cline")) return TOOLS.cline;
  return STATUS.neutral;
}

/**
 * Get the navigation icon for a view.
 */
export function getViewIcon(
  view: "tools" | "sessions" | "handoff" | "config" | "terminal",
): IconName {
  const map: Record<typeof view, IconName> = {
    tools: "nav.tools",
    sessions: "nav.sessions",
    handoff: "nav.handoff",
    config: "nav.config",
    terminal: "nav.terminal",
  };
  return map[view];
}

/**
 * Get the status icon for a given status.
 */
export function getStatusIcon(
  status:
    | "success"
    | "error"
    | "warning"
    | "info"
    | "pending"
    | "running"
    | "stopped"
    | "stale"
    | "unknown",
): IconName {
  const map: Record<typeof status, IconName> = {
    success: "status.success",
    error: "status.error",
    warning: "status.warning",
    info: "status.info",
    pending: "status.pending",
    running: "status.running",
    stopped: "status.stopped",
    stale: "status.stale",
    unknown: "status.unknown",
  };
  return map[status];
}

// ─────────────────────────────────────────────────────────────
// Rezi INTEGRATION HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Create props for ui.icon() with proper styling.
 *
 * Usage:
 *   ui.icon(...makeIconProps("status.success", { fg: STATUS.success }))
 */
export function makeIconProps(
  name: IconName,
  style?: { fg?: RgbColor | string; bg?: RgbColor | string; bold?: boolean },
  useFallback = false,
): [string, { style?: Record<string, unknown>; fallback?: boolean }] {
  const icon = getIcon(name);
  return [
    useFallback ? icon.fallback : icon.glyph,
    {
      style: style ?? {},
      fallback: useFallback,
    },
  ];
}

/**
 * Create a rich text span for an icon.
 *
 * Usage:
 *   ui.richText([iconSpan("status.success", STATUS.success), { text: " Done" }])
 */
export function iconSpan(
  name: IconName,
  fg?: RgbColor,
  useFallback = false,
): { text: string; style?: { fg?: RgbColor; bold?: boolean } } {
  const icon = getIcon(name);
  return {
    text: useFallback ? icon.fallback : icon.glyph,
    style: fg ? { fg, bold: true } : undefined,
  };
}
