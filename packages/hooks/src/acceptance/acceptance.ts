import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** User-owned. The agent must not write this file. */
export const COMMANDS_RELATIVE = ".ai-tools/acceptance-commands.json";
/** Agent-writable checklist. Only a matching shell result may set passes. */
export const ACCEPTANCE_RELATIVE = ".ai-tools/acceptance.json";
/** Written when a UI file is touched, so a UI item becomes required. */
export const UI_MARKER_RELATIVE = ".ai-tools/acceptance-ui";

export const CORE_CLASSES = ["requested", "empty", "error", "shared-state", "regression"] as const;

export type CoreClass = (typeof CORE_CLASSES)[number];
export type AcceptanceClass = CoreClass | "ui";

export type AcceptanceItem = {
  id: string;
  class: AcceptanceClass;
  /** Observable behavior. A leading "REPLACE:" means the agent has not filled it in. */
  behavior: string;
  passes: boolean;
  /** Short stdout excerpt recorded by the shell hook. The agent cannot invent this. */
  excerpt?: string;
};

export type AcceptanceFile = {
  version: 1;
  items: AcceptanceItem[];
};

export type AcceptanceCommands = Partial<Record<AcceptanceClass, string>>;

const CLASSES = new Set<string>([...CORE_CLASSES, "ui"]);

export function acceptanceSkeleton(): AcceptanceFile {
  return {
    version: 1,
    items: CORE_CLASSES.map((cls) => ({
      id: `${cls}-1`,
      class: cls,
      behavior: `REPLACE: ${cls}`,
      passes: false,
    })),
  };
}

export function uiItem(): AcceptanceItem {
  return { id: "ui-1", class: "ui", behavior: "REPLACE: ui", passes: false };
}

export function isAcceptancePath(filePath: string): boolean {
  return (
    normalizePath(filePath).endsWith(`/${ACCEPTANCE_RELATIVE}`) ||
    normalizePath(filePath).endsWith(ACCEPTANCE_RELATIVE)
  );
}

export function isCommandsPath(filePath: string): boolean {
  return (
    normalizePath(filePath).endsWith(`/${COMMANDS_RELATIVE}`) ||
    normalizePath(filePath).endsWith(COMMANDS_RELATIVE)
  );
}

export function isUiSourcePath(filePath: string): boolean {
  return /\.(tsx|jsx|vue|svelte|css|html)$/i.test(normalizePath(filePath));
}

export function isDoneClaim(prompt: string): boolean {
  return /^(done|ship(?:\s+it)?|lgtm|complete|completed|finished|ready to (?:merge|ship)|that(?:'s| is) all)\b/i.test(
    prompt.trim(),
  );
}

export function readAcceptance(cwd: string): AcceptanceFile | null {
  return readJson(join(cwd, ACCEPTANCE_RELATIVE));
}

export function readCommands(cwd: string): AcceptanceCommands | null {
  return readJson(join(cwd, COMMANDS_RELATIVE));
}

export function uiMarkerPresent(cwd: string): boolean {
  return existsSync(join(cwd, UI_MARKER_RELATIVE));
}

export function writeAcceptance(cwd: string, file: AcceptanceFile): void {
  const full = join(cwd, ACCEPTANCE_RELATIVE);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export function writeUiMarker(cwd: string): void {
  const full = join(cwd, UI_MARKER_RELATIVE);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "1\n", "utf8");
}

export function parseAcceptance(
  content: string,
): { ok: true; file: AcceptanceFile } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return { ok: false, reason: `${ACCEPTANCE_RELATIVE} is not JSON.` };
  }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.items)) {
    return {
      ok: false,
      reason: `${ACCEPTANCE_RELATIVE} must be { "version": 1, "items": [...] }.`,
    };
  }
  const items: AcceptanceItem[] = [];
  const ids = new Set<string>();
  for (const raw of value.items) {
    const item = parseItem(raw);
    if (!item.ok) return item;
    if (ids.has(item.item.id)) {
      return { ok: false, reason: `Duplicate acceptance id "${item.item.id}".` };
    }
    ids.add(item.item.id);
    items.push(item.item);
  }
  return { ok: true, file: { version: 1, items } };
}

/**
 * Accept a model write of the checklist.
 * passes can stay true only when the previous file already proved that id.
 * A filled-in behavior is frozen. Items cannot be removed.
 */
export function validateAcceptanceWrite(
  previous: AcceptanceFile | null,
  next: AcceptanceFile,
): { ok: true } | { ok: false; reason: string } {
  const missing = CORE_CLASSES.filter((cls) => !next.items.some((item) => item.class === cls));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `${ACCEPTANCE_RELATIVE} is missing classes: ${missing.join(", ")}. Start from acceptanceSkeleton().`,
    };
  }

  const previousById = new Map((previous?.items ?? []).map((item) => [item.id, item]));
  for (const prior of previous?.items ?? []) {
    const kept = next.items.find((item) => item.id === prior.id);
    if (!kept) {
      return { ok: false, reason: `Cannot remove acceptance item "${prior.id}".` };
    }
    if (kept.class !== prior.class) {
      return { ok: false, reason: `Cannot change class of acceptance item "${prior.id}".` };
    }
    if (!prior.behavior.startsWith("REPLACE:") && kept.behavior !== prior.behavior) {
      return {
        ok: false,
        reason: `Cannot change the behavior of acceptance item "${prior.id}" after it was filled in.`,
      };
    }
  }

  for (const item of next.items) {
    const prior = previousById.get(item.id);
    if (!item.passes) continue;
    if (!prior?.passes || prior.excerpt !== item.excerpt || prior.behavior !== item.behavior) {
      return {
        ok: false,
        reason: `Cannot set passes on "${item.id}". A user-owned command in ${COMMANDS_RELATIVE} has to exit 0 and print acceptance:${item.id}.`,
      };
    }
  }
  return { ok: true };
}

export function applyEvidence(
  file: AcceptanceFile,
  commands: AcceptanceCommands,
  command: string,
  exitCode: number,
  stdout: string,
): AcceptanceFile {
  if (exitCode !== 0) return file;
  const normalized = normalizeCommand(command);
  let changed = false;
  const items = file.items.map((item) => {
    const allowed = commands[item.class];
    if (!allowed || item.passes || item.behavior.startsWith("REPLACE:")) return item;
    if (!commandMatches(normalized, normalizeCommand(allowed))) return item;
    if (!stdout.includes(`acceptance:${item.id}`)) return item;
    changed = true;
    return { ...item, passes: true, excerpt: stdout.trim().slice(0, 400) };
  });
  return changed ? { ...file, items } : file;
}

export function openItems(file: AcceptanceFile, requireUi: boolean): AcceptanceItem[] {
  const open = file.items.filter(
    (item) => !item.passes || item.behavior.startsWith("REPLACE:") || !item.excerpt,
  );
  if (requireUi && !file.items.some((item) => item.class === "ui")) {
    open.push(uiItem());
  }
  return open;
}

export function formatOpen(items: AcceptanceItem[], commands: AcceptanceCommands): string {
  const lines = ["Acceptance list is still open. Do not stop.", ""];
  for (const item of items) {
    const command = commands[item.class];
    const evidence = command
      ? `run a command matching "${command}" whose stdout includes acceptance:${item.id}`
      : `no command is configured for class "${item.class}" in ${COMMANDS_RELATIVE} (that file is user-owned)`;
    lines.push(`- ${item.id} (${item.class}): ${item.behavior}`);
    lines.push(`  evidence: ${evidence}`);
  }
  return lines.join("\n");
}

function parseItem(
  raw: unknown,
): { ok: true; item: AcceptanceItem } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "Each acceptance item must be an object." };
  const id = raw.id;
  const cls = raw.class;
  const behavior = raw.behavior;
  const passes = raw.passes;
  if (typeof id !== "string" || id.length === 0)
    return { ok: false, reason: "Acceptance item id must be a string." };
  if (typeof cls !== "string" || !CLASSES.has(cls)) {
    return {
      ok: false,
      reason: `Acceptance class "${String(cls)}" is not one of ${[...CLASSES].join(", ")}.`,
    };
  }
  if (typeof behavior !== "string" || behavior.trim().length === 0) {
    return { ok: false, reason: `Acceptance item "${id}" needs a behavior.` };
  }
  if (typeof passes !== "boolean")
    return { ok: false, reason: `Acceptance item "${id}" needs passes: false.` };
  const excerpt = raw.excerpt;
  if (excerpt !== undefined && typeof excerpt !== "string") {
    return { ok: false, reason: `Acceptance item "${id}" excerpt must be a string.` };
  }
  return {
    ok: true,
    item: {
      id,
      class: cls as AcceptanceClass,
      behavior,
      passes,
      ...(typeof excerpt === "string" ? { excerpt } : {}),
    },
  };
}

function commandMatches(command: string, prefix: string): boolean {
  return command === prefix || command.startsWith(`${prefix} `);
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

function readJson<T>(full: string): T | null {
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, "utf8")) as T;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
