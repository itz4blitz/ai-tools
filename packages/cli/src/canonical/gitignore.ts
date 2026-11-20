import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const START_MARKER = "# ── ai-tools managed (canonical mode) ──";
const END_MARKER = "# ── end ai-tools managed ──";

const MANAGED_BLOCK = `${START_MARKER}
.claude/
.cursor/
.opencode/
.gemini/
.cline/
.clinerules/
.factory/
.codex/
.kiro/
.amp/
.grok/
.zcode/
.continue/
.roo/
.roomodes
.agents/
.windsurf/
${END_MARKER}`;

export async function addManagedBlock(cwd?: string): Promise<void> {
  const filePath = resolve(cwd ?? process.cwd(), ".gitignore");

  let content = "";
  if (existsSync(filePath)) {
    content = await readFile(filePath, "utf-8");
  }

  if (content.includes(START_MARKER)) return;

  const separator = content.length > 0 && !content.endsWith("\n") ? "\n\n" : "\n";
  const prefix = content.length > 0 ? separator : "";
  await writeFile(filePath, content + prefix + MANAGED_BLOCK + "\n", "utf-8");
}

export async function removeManagedBlock(cwd?: string): Promise<void> {
  const filePath = resolve(cwd ?? process.cwd(), ".gitignore");

  if (!existsSync(filePath)) return;

  const content = await readFile(filePath, "utf-8");
  if (!content.includes(START_MARKER)) return;

  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx < 0 || endIdx < 0) return;

  const endOfBlock = endIdx + END_MARKER.length;
  const before = content.slice(0, startIdx);
  const after = content.slice(endOfBlock);

  // Clean up extra newlines
  const cleaned = (before + after)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .trimEnd();
  await writeFile(filePath, cleaned.length > 0 ? cleaned + "\n" : "", "utf-8");
}

export async function hasManagedBlock(cwd?: string): Promise<boolean> {
  const filePath = resolve(cwd ?? process.cwd(), ".gitignore");
  if (!existsSync(filePath)) return false;
  const content = await readFile(filePath, "utf-8");
  return content.includes(START_MARKER) && content.includes(END_MARKER);
}
