import { hook } from "../config/define.js";
import type { HookDefinition } from "../types/index.js";
import {
  ACCEPTANCE_RELATIVE,
  COMMANDS_RELATIVE,
  applyEvidence,
  formatOpen,
  isAcceptancePath,
  isCommandsPath,
  isDoneClaim,
  isUiSourcePath,
  openItems,
  parseAcceptance,
  readAcceptance,
  readCommands,
  uiMarkerPresent,
  validateAcceptanceWrite,
  writeAcceptance,
  writeUiMarker,
} from "../acceptance/acceptance.js";

function fileContents(event: { type: string; content?: string; newContent?: string }): string {
  if (event.type === "file:write") return event.content ?? "";
  if (event.type === "file:edit") return event.newContent ?? "";
  return "";
}

function filePath(event: { path?: string }): string {
  return event.path ?? "";
}

/**
 * Blocks a model write that self-certifies the checklist or drops a required class.
 * Also blocks writes to the user-owned command allowlist.
 */
export const guardAcceptanceWrite = hook(
  "before",
  ["file:write", "file:edit"],
  async (ctx, next) => {
    const path = filePath(ctx.event);
    if (isCommandsPath(path)) {
      ctx.results.push({
        blocked: true,
        reason: `${COMMANDS_RELATIVE} is user-owned. Do not write it.`,
      });
      return;
    }
    if (!isAcceptancePath(path)) {
      await next();
      return;
    }

    const parsed = parseAcceptance(fileContents(ctx.event));
    if (!parsed.ok) {
      ctx.results.push({ blocked: true, reason: parsed.reason });
      return;
    }
    const verdict = validateAcceptanceWrite(readAcceptance(ctx.cwd), parsed.file);
    if (!verdict.ok) {
      ctx.results.push({ blocked: true, reason: verdict.reason });
      return;
    }
    await next();
  },
)
  .id("ai-hooks:guard-acceptance")
  .name("Guard Acceptance List")
  .description(
    "Stops the agent from marking acceptance items done or editing the command allowlist.",
  )
  .priority(20)
  .build();

/** Remember that this task touched UI, so a ui-class item becomes required. */
export const noteUiSurface = hook("before", ["file:write", "file:edit"], async (ctx, next) => {
  const path = filePath(ctx.event);
  if (!isAcceptancePath(path) && !isCommandsPath(path) && isUiSourcePath(path)) {
    writeUiMarker(ctx.cwd);
  }
  await next();
})
  .id("ai-hooks:note-ui-surface")
  .name("Note UI Surface")
  .description("Records that a UI file was written so the acceptance list must include a ui item.")
  .priority(21)
  .build();

/**
 * The only writer of passes:true. The command prefix comes from the allowlist,
 * and stdout must contain acceptance:<id>.
 */
export const recordAcceptanceEvidence = hook("after", ["shell:after"], async (ctx, next) => {
  const file = readAcceptance(ctx.cwd);
  const commands = readCommands(ctx.cwd);
  if (!file || !commands || ctx.event.type !== "shell:after") {
    await next();
    return;
  }
  const nextFile = applyEvidence(
    file,
    commands,
    ctx.event.command,
    ctx.event.exitCode,
    ctx.event.stdout,
  );
  if (nextFile !== file) writeAcceptance(ctx.cwd, nextFile);
  await next();
})
  .id("ai-hooks:record-acceptance")
  .name("Record Acceptance Evidence")
  .description(
    "Marks an acceptance item proven only when its user-owned command exits 0 and prints its id.",
  )
  .priority(50)
  .build();

async function refuseOrRemind(
  cwd: string,
  claimDone: boolean,
  push: (result: { blocked?: boolean; reason?: string; data?: Record<string, unknown> }) => void,
): Promise<boolean> {
  const file = readAcceptance(cwd);
  const commands = readCommands(cwd) ?? {};
  const requireUi = uiMarkerPresent(cwd);
  if (!file) {
    if (claimDone && requireUi) {
      push({
        blocked: true,
        reason: `Write ${ACCEPTANCE_RELATIVE} before stopping. Add a ui item. acceptanceSkeleton() is the shape.`,
      });
      return true;
    }
    return false;
  }
  const open = openItems(file, requireUi);
  if (open.length === 0) return false;
  const reason = formatOpen(open, commands);
  if (claimDone) {
    push({ blocked: true, reason });
    return true;
  }
  push({ data: { additionalContext: reason } });
  return false;
}

/** On a done-claim, refuse to continue. Otherwise put the open items back in context. */
export const remindAcceptance = hook(
  "before",
  ["prompt:submit", "session:start"],
  async (ctx, next) => {
    const claimDone = ctx.event.type === "prompt:submit" && isDoneClaim(ctx.event.prompt);
    const blocked = await refuseOrRemind(ctx.cwd, claimDone, (result) => ctx.results.push(result));
    if (!blocked) await next();
  },
)
  .id("ai-hooks:remind-acceptance")
  .name("Remind Acceptance")
  .description(
    "Injects the open acceptance items, and blocks a prompt that claims the work is done.",
  )
  .priority(30)
  .build();

/** Stop / session end cannot succeed while an item is still open. */
export const refuseUnprovenStop = hook("after", ["session:end"], async (ctx, next) => {
  await refuseOrRemind(ctx.cwd, true, (result) => ctx.results.push(result));
  await next();
})
  .id("ai-hooks:refuse-unproven-stop")
  .name("Refuse Unproven Stop")
  .description("Blocks session end while any acceptance item lacks evidence.")
  .priority(30)
  .build();

export const acceptanceHooks: HookDefinition[] = [
  guardAcceptanceWrite,
  noteUiSurface,
  recordAcceptanceEvidence,
  remindAcceptance,
  refuseUnprovenStop,
];
