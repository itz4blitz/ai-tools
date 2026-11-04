import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptanceSkeleton,
  applyEvidence,
  parseAcceptance,
  validateAcceptanceWrite,
  writeAcceptance,
} from "../acceptance/acceptance.js";
import {
  guardAcceptanceWrite,
  noteUiSurface,
  recordAcceptanceEvidence,
  remindAcceptance,
  refuseUnprovenStop,
} from "./acceptance.js";
import type { HookContext, HookEvent } from "../types/index.js";

function cwd(): string {
  return mkdtempSync(join(tmpdir(), "acceptance-"));
}

function ctx(event: HookEvent, dir: string): HookContext {
  return {
    event,
    tool: { name: "test", version: "1.0" },
    cwd: dir,
    state: new Map(),
    results: [],
    startedAt: Date.now(),
  };
}

const next = async () => {};

describe("acceptance checklist", () => {
  it("starts every core class at passes false", () => {
    const file = acceptanceSkeleton();
    expect(file.items.map((item) => item.class)).toEqual([
      "requested",
      "empty",
      "error",
      "shared-state",
      "regression",
    ]);
    expect(file.items.every((item) => item.passes === false)).toBe(true);
  });

  it("rejects a write that sets passes", () => {
    const file = acceptanceSkeleton();
    file.items[0] = { ...file.items[0]!, passes: true, excerpt: "acceptance:requested-1" };
    const verdict = validateAcceptanceWrite(null, file);
    expect(verdict.ok).toBe(false);
  });

  it("rejects a write that drops a class or a locked behavior", () => {
    const first = acceptanceSkeleton();
    expect(validateAcceptanceWrite(null, first).ok).toBe(true);
    const dropped = { ...first, items: first.items.slice(1) };
    expect(validateAcceptanceWrite(first, dropped).ok).toBe(false);

    const filled = structuredClone(first);
    filled.items[0] = { ...filled.items[0]!, behavior: "The empty list renders an empty state." };
    expect(validateAcceptanceWrite(first, filled).ok).toBe(true);
    const rewritten = structuredClone(filled);
    rewritten.items[0] = { ...rewritten.items[0]!, behavior: "something easier" };
    expect(validateAcceptanceWrite(filled, rewritten).ok).toBe(false);
  });

  it("proves an item only when the allowlisted command prints its id", () => {
    const file = acceptanceSkeleton();
    file.items[0] = { ...file.items[0]!, behavior: "Save persists a row." };
    const commands = { requested: "npm test" };
    const missed = applyEvidence(
      file,
      commands,
      "echo acceptance:requested-1",
      0,
      "acceptance:requested-1",
    );
    expect(missed.items[0]!.passes).toBe(false);
    const proved = applyEvidence(
      file,
      commands,
      "npm test -- src/row.test.ts",
      0,
      "ok acceptance:requested-1",
    );
    expect(proved.items[0]!.passes).toBe(true);
    expect(proved.items[1]!.passes).toBe(false);
  });

  it("blocks a model write that marks an item done", async () => {
    const dir = cwd();
    const file = acceptanceSkeleton();
    file.items[0] = { ...file.items[0]!, passes: true };
    const result = ctx(
      {
        type: "file:write",
        path: join(dir, ".ai-tools", "acceptance.json"),
        content: JSON.stringify(file),
        timestamp: 0,
        metadata: {},
      },
      dir,
    );
    await guardAcceptanceWrite.handler(result, next);
    expect(result.results[0]?.blocked).toBe(true);
  });

  it("blocks a done claim and a stop while items are open, and records real evidence", async () => {
    const dir = cwd();
    const file = acceptanceSkeleton();
    for (const item of file.items) item.behavior = `Observe ${item.id}`;
    writeAcceptance(dir, file);
    mkdirSync(join(dir, ".ai-tools"), { recursive: true });
    writeFileSync(
      join(dir, ".ai-tools", "acceptance-commands.json"),
      JSON.stringify({
        requested: "npm test",
        empty: "npm test",
        error: "npm test",
        "shared-state": "npm test",
        regression: "npm test",
      }),
    );

    const prompt = ctx({ type: "prompt:submit", prompt: "done", timestamp: 0, metadata: {} }, dir);
    await remindAcceptance.handler(prompt, next);
    expect(prompt.results[0]?.blocked).toBe(true);
    expect(prompt.results[0]?.reason).toContain("requested-1");

    const stop = ctx(
      { type: "session:end", tool: "codex", duration: 0, timestamp: 0, metadata: {} },
      dir,
    );
    await refuseUnprovenStop.handler(stop, next);
    expect(stop.results[0]?.blocked).toBe(true);

    const shell = ctx(
      {
        type: "shell:after",
        command: "npm test",
        cwd: dir,
        exitCode: 0,
        stdout: file.items.map((item) => `acceptance:${item.id}`).join("\n"),
        stderr: "",
        duration: 1,
        timestamp: 0,
        metadata: {},
      },
      dir,
    );
    await recordAcceptanceEvidence.handler(shell, next);
    const saved = parseAcceptance(readFileSync(join(dir, ".ai-tools", "acceptance.json"), "utf8"));
    expect(saved.ok && saved.file.items.every((item) => item.passes)).toBe(true);

    const again = ctx(
      { type: "prompt:submit", prompt: "ship it", timestamp: 0, metadata: {} },
      dir,
    );
    await remindAcceptance.handler(again, next);
    expect(again.results[0]?.blocked).toBeUndefined();
  });

  it("requires a ui item after a UI file is written", async () => {
    const dir = cwd();
    writeAcceptance(dir, acceptanceSkeleton());
    const write = ctx(
      {
        type: "file:write",
        path: join(dir, "src", "Panel.tsx"),
        content: "export {}",
        timestamp: 0,
        metadata: {},
      },
      dir,
    );
    await noteUiSurface.handler(write, next);
    const stop = ctx(
      { type: "session:end", tool: "cursor", duration: 0, timestamp: 0, metadata: {} },
      dir,
    );
    await refuseUnprovenStop.handler(stop, next);
    expect(stop.results[0]?.reason).toContain("ui-1");
  });
});
