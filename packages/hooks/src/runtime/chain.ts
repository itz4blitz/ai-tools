import type { HookDefinition, HookContext, HookResult } from "../types/index.js";

/**
 * Execute a chain of hooks in priority order with Express.js-style next() flow.
 *
 * Each hook calls `next()` to pass control to the next hook in the chain.
 * If a hook doesn't call `next()`, the chain stops (short-circuit).
 * Before hooks can block events by setting `ctx.results` with `blocked: true`.
 */
export async function executeChain(
  hooks: HookDefinition[],
  ctx: HookContext,
  timeout: number,
): Promise<HookResult[]> {
  const sorted = [...hooks].toSorted((a, b) => (a.priority ?? 100) - (b.priority ?? 100));

  let index = 0;

  const next = async (): Promise<void> => {
    if (index >= sorted.length) return;

    const hook = sorted[index];
    /* v8 ignore next -- unreachable: guarded by index >= sorted.length above */
    if (!hook) return;
    index++;

    // Skip disabled hooks
    if (hook.enabled === false) {
      await next();
      return;
    }

    // Skip if filter doesn't match
    if (hook.filter && !hook.filter(ctx.event)) {
      await next();
      return;
    }

    // Check if a previous hook already blocked
    const blocked = ctx.results.some((r) => r.blocked);
    if (blocked && hook.phase === "before") {
      return; // Stop chain on block
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(hook.handler(ctx, next)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HookTimeoutError(hook.id, timeout)), timeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    await next();
  } catch (error) {
    if (error instanceof HookTimeoutError) {
      ctx.results.push({
        blocked: false,
        reason: `Hook "${error.hookId}" timed out after ${error.timeout}ms`,
      });
    } else {
      throw error;
    }
  }

  return ctx.results;
}

export class HookTimeoutError extends Error {
  constructor(
    public readonly hookId: string,
    public readonly timeout: number,
  ) {
    super(`Hook "${hookId}" timed out after ${timeout}ms`);
    this.name = "HookTimeoutError";
  }
}
