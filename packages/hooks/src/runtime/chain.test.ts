import { describe, it, expect, vi } from "vitest";
import { executeChain, HookTimeoutError } from "./chain.js";
import type { HookDefinition, HookContext, HookEvent } from "../types/index.js";

function makeCtx(event?: Partial<HookEvent>): HookContext {
  return {
    event: {
      type: "shell:before",
      command: "ls",
      cwd: "/tmp",
      timestamp: Date.now(),
      metadata: {},
      ...event,
    } as HookEvent,
    tool: { name: "test", version: "1.0" },
    cwd: "/tmp",
    state: new Map(),
    results: [],
    startedAt: Date.now(),
  };
}

describe("executeChain", () => {
  it("executes hooks in priority order", async () => {
    const order: string[] = [];
    const hooks: HookDefinition[] = [
      {
        id: "third",
        name: "third",
        events: ["shell:before"],
        phase: "before",
        priority: 300,
        handler: async (_ctx, next) => {
          order.push("third");
          await next();
        },
      },
      {
        id: "first",
        name: "first",
        events: ["shell:before"],
        phase: "before",
        priority: 10,
        handler: async (_ctx, next) => {
          order.push("first");
          await next();
        },
      },
      {
        id: "second",
        name: "second",
        events: ["shell:before"],
        phase: "before",
        priority: 50,
        handler: async (_ctx, next) => {
          order.push("second");
          await next();
        },
      },
    ];

    const ctx = makeCtx();
    await executeChain(hooks, ctx, 5000);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("stops chain when hook does not call next()", async () => {
    const order: string[] = [];
    const hooks: HookDefinition[] = [
      {
        id: "stopper",
        name: "stopper",
        events: ["shell:before"],
        phase: "before",
        priority: 1,
        handler: async () => {
          order.push("stopper");
          // no next() call
        },
      },
      {
        id: "unreachable",
        name: "unreachable",
        events: ["shell:before"],
        phase: "before",
        priority: 2,
        handler: async (_ctx, next) => {
          order.push("unreachable");
          await next();
        },
      },
    ];

    await executeChain(hooks, makeCtx(), 5000);
    expect(order).toEqual(["stopper"]);
  });

  it("stops chain on block result for before hooks", async () => {
    const order: string[] = [];
    const hooks: HookDefinition[] = [
      {
        id: "blocker",
        name: "blocker",
        events: ["shell:before"],
        phase: "before",
        priority: 1,
        handler: async (ctx, next) => {
          ctx.results.push({ blocked: true, reason: "blocked" });
          order.push("blocker");
          await next();
        },
      },
      {
        id: "skipped",
        name: "skipped",
        events: ["shell:before"],
        phase: "before",
        priority: 2,
        handler: async (_ctx, next) => {
          order.push("skipped");
          await next();
        },
      },
    ];

    const ctx = makeCtx();
    const results = await executeChain(hooks, ctx, 5000);
    expect(order).toEqual(["blocker"]);
    expect(results).toHaveLength(1);
    expect(results[0]?.blocked).toBe(true);
  });

  it("skips disabled hooks", async () => {
    const order: string[] = [];
    const hooks: HookDefinition[] = [
      {
        id: "disabled",
        name: "disabled",
        events: ["shell:before"],
        phase: "before",
        enabled: false,
        handler: async (_ctx, next) => {
          order.push("disabled");
          await next();
        },
      },
      {
        id: "enabled",
        name: "enabled",
        events: ["shell:before"],
        phase: "before",
        handler: async (_ctx, next) => {
          order.push("enabled");
          await next();
        },
      },
    ];

    await executeChain(hooks, makeCtx(), 5000);
    expect(order).toEqual(["enabled"]);
  });

  it("skips hooks when filter returns false", async () => {
    const order: string[] = [];
    const hooks: HookDefinition[] = [
      {
        id: "filtered",
        name: "filtered",
        events: ["shell:before"],
        phase: "before",
        filter: () => false,
        handler: async (_ctx, next) => {
          order.push("filtered");
          await next();
        },
      },
      {
        id: "unfiltered",
        name: "unfiltered",
        events: ["shell:before"],
        phase: "before",
        handler: async (_ctx, next) => {
          order.push("unfiltered");
          await next();
        },
      },
    ];

    await executeChain(hooks, makeCtx(), 5000);
    expect(order).toEqual(["unfiltered"]);
  });

  it("handles hook timeout gracefully", async () => {
    const hooks: HookDefinition[] = [
      {
        id: "slow",
        name: "slow",
        events: ["shell:before"],
        phase: "before",
        handler: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
        },
      },
    ];

    const ctx = makeCtx();
    const results = await executeChain(hooks, ctx, 50);
    expect(results).toHaveLength(1);
    expect(results[0]?.blocked).toBe(false);
    expect(results[0]?.reason).toContain("timed out");
  });

  it("clears the timeout timer when a hook resolves before timing out", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const hooks: HookDefinition[] = [
      {
        id: "fast",
        name: "fast",
        events: ["shell:before"],
        phase: "before",
        handler: async (ctx, next) => {
          void ctx;
          await next();
        },
      },
    ];

    await executeChain(hooks, makeCtx(), 5000);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("propagates non-timeout errors", async () => {
    const hooks: HookDefinition[] = [
      {
        id: "broken",
        name: "broken",
        events: ["shell:before"],
        phase: "before",
        handler: async () => {
          throw new Error("something broke");
        },
      },
    ];

    await expect(executeChain(hooks, makeCtx(), 5000)).rejects.toThrow("something broke");
  });

  it("passes shared state between hooks", async () => {
    const hooks: HookDefinition[] = [
      {
        id: "setter",
        name: "setter",
        events: ["shell:before"],
        phase: "before",
        priority: 1,
        handler: async (ctx, next) => {
          ctx.state.set("key", "value");
          await next();
        },
      },
      {
        id: "getter",
        name: "getter",
        events: ["shell:before"],
        phase: "before",
        priority: 2,
        handler: async (ctx, next) => {
          ctx.results.push({ data: { got: ctx.state.get("key") } });
          await next();
        },
      },
    ];

    const ctx = makeCtx();
    const results = await executeChain(hooks, ctx, 5000);
    expect(results[0]?.data).toEqual({ got: "value" });
  });

  it("uses default priority 100 when not specified", async () => {
    const order: string[] = [];
    const hooks: HookDefinition[] = [
      {
        id: "default-priority",
        name: "default-priority",
        events: ["shell:before"],
        phase: "before",
        handler: async (_ctx, next) => {
          order.push("default");
          await next();
        },
      },
      {
        id: "low-priority",
        name: "low-priority",
        events: ["shell:before"],
        phase: "before",
        priority: 50,
        handler: async (_ctx, next) => {
          order.push("low");
          await next();
        },
      },
    ];

    await executeChain(hooks, makeCtx(), 5000);
    expect(order).toEqual(["low", "default"]);
  });
});

describe("HookTimeoutError", () => {
  it("stores hookId and timeout", () => {
    const err = new HookTimeoutError("my-hook", 3000);
    expect(err.hookId).toBe("my-hook");
    expect(err.timeout).toBe(3000);
    expect(err.name).toBe("HookTimeoutError");
    expect(err.message).toContain("my-hook");
    expect(err.message).toContain("3000ms");
  });
});
