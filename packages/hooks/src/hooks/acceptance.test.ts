import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptanceSkeleton,
  applyEvidence,
  formatOpen,
  parseAcceptance,
  readAcceptance,
  validateAcceptanceWrite,
  writeAcceptance,
  type AcceptanceFile,
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

  it("rejects malformed items, locked edits, and unproven commands", () => {
    expect(parseAcceptance("nope").ok).toBe(false);
    expect(parseAcceptance("[]").ok).toBe(false);
    expect(parseAcceptance('{"version":1,"items":[{}]}').ok).toBe(false);
    const skeleton = acceptanceSkeleton();
    const duplicate = structuredClone(skeleton);
    duplicate.items.push({ ...duplicate.items[0]! });
    expect(parseAcceptance(JSON.stringify(duplicate)).ok).toBe(false);
    expect(parseAcceptance(JSON.stringify({ version: 1, items: ["x"] })).ok).toBe(false);
    const blankId = structuredClone(skeleton);
    blankId.items[0] = { ...blankId.items[0]!, id: "" };
    expect(parseAcceptance(JSON.stringify(blankId)).ok).toBe(false);
    const badClass = structuredClone(skeleton);
    badClass.items[0] = {
      ...badClass.items[0]!,
      class: "nope" as AcceptanceFile["items"][number]["class"],
    };
    expect(parseAcceptance(JSON.stringify(badClass)).ok).toBe(false);
    const blankBehavior = structuredClone(skeleton);
    blankBehavior.items[0] = { ...blankBehavior.items[0]!, behavior: " " };
    expect(parseAcceptance(JSON.stringify(blankBehavior)).ok).toBe(false);
    const badPasses = structuredClone(skeleton);
    (badPasses.items[0] as { passes: unknown }).passes = "no";
    expect(parseAcceptance(JSON.stringify(badPasses)).ok).toBe(false);
    const badExcerpt = structuredClone(skeleton);
    (badExcerpt.items[0] as { excerpt: unknown }).excerpt = 1;
    expect(parseAcceptance(JSON.stringify(badExcerpt)).ok).toBe(false);

    const extra = structuredClone(skeleton);
    extra.items.push({
      id: "requested-2",
      class: "requested",
      behavior: "REPLACE: requested",
      passes: false,
    });
    const removed = { ...extra, items: extra.items.filter((item) => item.id !== "requested-2") };
    expect(validateAcceptanceWrite(extra, removed).ok).toBe(false);
    const reclassed = structuredClone(extra);
    reclassed.items[0] = { ...reclassed.items[0]!, class: "ui" };
    expect(validateAcceptanceWrite(extra, reclassed).ok).toBe(false);

    const proved = structuredClone(skeleton);
    proved.items[0] = {
      ...proved.items[0]!,
      behavior: "Save persists a row.",
      passes: true,
      excerpt: "acceptance:requested-1",
    };
    expect(validateAcceptanceWrite(proved, structuredClone(proved)).ok).toBe(true);

    const open = acceptanceSkeleton();
    open.items[0] = { ...open.items[0]!, behavior: "Save persists a row.", passes: true };
    expect(
      applyEvidence(open, { requested: "npm test" }, "npm test", 1, "acceptance:requested-1")
        .items[0]!.passes,
    ).toBe(true);
    const unchanged = applyEvidence(
      skeleton,
      { requested: "npm test" },
      "npm   test",
      0,
      "acceptance:requested-1",
    );
    expect(unchanged.items[0]!.passes).toBe(false);
    expect(formatOpen(open.items, {}).includes("no command is configured")).toBe(true);
    const already = structuredClone(open);
    already.items[0] = { ...already.items[0]!, excerpt: "acceptance:requested-1" };
    expect(
      applyEvidence(already, { requested: "npm test" }, "npm test", 0, "acceptance:requested-1")
        .items[0]!.excerpt,
    ).toBe("acceptance:requested-1");
    expect(applyEvidence(open, {}, "npm test", 0, "acceptance:requested-1").items[0]!.passes).toBe(
      true,
    );
  });

  it("guards writes, reminds on an open list, and ignores a stop with no list", async () => {
    const dir = cwd();
    mkdirSync(join(dir, ".ai-tools"), { recursive: true });
    let continued = false;
    const allow = async () => {
      continued = true;
    };

    const commands = ctx(
      {
        type: "file:write",
        path: join(dir, ".ai-tools", "acceptance-commands.json"),
        content: "{}",
        timestamp: 0,
        metadata: {},
      },
      dir,
    );
    await guardAcceptanceWrite.handler(commands, allow);
    expect(commands.results[0]?.blocked).toBe(true);

    continued = false;
    const other = ctx(
      {
        type: "file:write",
        path: join(dir, "src", "row.ts"),
        content: "export {}",
        timestamp: 0,
        metadata: {},
      },
      dir,
    );
    await guardAcceptanceWrite.handler(other, allow);
    expect(continued).toBe(true);
    await noteUiSurface.handler(other, allow);
    expect(existsSync(join(dir, ".ai-tools", "acceptance-ui"))).toBe(false);

    const broken = ctx(
      {
        type: "file:edit",
        path: join(dir, ".ai-tools", "acceptance.json"),
        oldContent: "",
        newContent: "{",
        timestamp: 0,
        metadata: {},
      },
      dir,
    );
    await guardAcceptanceWrite.handler(broken, allow);
    expect(broken.results[0]?.reason).toContain("not JSON");

    writeFileSync(join(dir, ".ai-tools", "acceptance.json"), "{");
    expect(readAcceptance(dir)).toBeNull();

    continued = false;
    const valid = ctx(
      {
        type: "file:write",
        path: ".ai-tools/acceptance.json",
        content: JSON.stringify(acceptanceSkeleton()),
        timestamp: 0,
        metadata: {},
      },
      dir,
    );
    await guardAcceptanceWrite.handler(valid, allow);
    expect(continued).toBe(true);

    writeAcceptance(dir, acceptanceSkeleton());
    const prompt = ctx(
      { type: "prompt:submit", prompt: "keep going", timestamp: 0, metadata: {} },
      dir,
    );
    continued = false;
    await remindAcceptance.handler(prompt, allow);
    expect(prompt.results[0]?.data?.additionalContext).toContain("requested-1");
    expect(continued).toBe(true);

    const started = ctx(
      {
        type: "session:start",
        tool: "claude-code",
        version: "1.0",
        workingDirectory: dir,
        timestamp: 0,
        metadata: {},
      },
      dir,
    );
    await remindAcceptance.handler(started, allow);
    expect(started.results[0]?.data?.additionalContext).toContain("no command is configured");

    const quiet = ctx(
      { type: "session:end", tool: "codex", duration: 0, timestamp: 0, metadata: {} },
      cwd(),
    );
    await refuseUnprovenStop.handler(quiet, allow);
    expect(quiet.results).toHaveLength(0);

    const shell = ctx(
      {
        type: "shell:after",
        command: "npm test",
        cwd: dir,
        exitCode: 0,
        stdout: "",
        stderr: "",
        duration: 1,
        timestamp: 0,
        metadata: {},
      },
      cwd(),
    );
    await recordAcceptanceEvidence.handler(shell, allow);
    expect(shell.results).toHaveLength(0);

    const missing = ctx(
      {
        type: "file:delete",
        path: join(dir, ".ai-tools", "acceptance.json"),
        timestamp: 0,
        metadata: {},
      },
      dir,
    );
    await guardAcceptanceWrite.handler(missing, allow);
    expect(missing.results[0]?.reason).toContain("not JSON");

    const uiDir = cwd();
    await noteUiSurface.handler(
      ctx(
        {
          type: "file:write",
          path: join(uiDir, "App.tsx"),
          content: "export {}",
          timestamp: 0,
          metadata: {},
        },
        uiDir,
      ),
      allow,
    );
    const uiStop = ctx(
      { type: "session:end", tool: "cursor", duration: 0, timestamp: 0, metadata: {} },
      uiDir,
    );
    await refuseUnprovenStop.handler(uiStop, allow);
    expect(uiStop.results[0]?.blocked).toBe(true);
    expect(uiStop.results[0]?.reason).toContain("ui item");
  });
});
