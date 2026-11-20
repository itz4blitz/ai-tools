import { describe, it, expect, beforeEach, vi } from "vitest";
import { registry } from "./registry.js";
import type { BaseSessionAdapter } from "./base.js";
import type { UnifiedSession, SessionFilter } from "../types/index.js";

function makeFakeAdapter(id: string, detects: boolean = true): BaseSessionAdapter {
  return {
    id,
    name: `${id} Adapter`,
    command: id,
    storagePaths: [`~/.${id}`],
    detect: async () => detects,
    parseSessions: async (filter?: SessionFilter) => {
      void filter;
      return [] as UnifiedSession[];
    },
    extractContext: async () => ({
      sessionId: "",
      tool: id,
      title: "",
      summary: "",
      keyFiles: [],
      keyDecisions: [],
      lastActivity: "",
      handoffMarkdown: "",
    }),
    getStoragePath: async () => null,
  } as unknown as BaseSessionAdapter;
}

describe("SessionAdapterRegistry", () => {
  beforeEach(() => {
    registry.clear();
  });

  describe("register / get", () => {
    it("registers and retrieves an adapter by id", () => {
      const adapter = makeFakeAdapter("claude");
      registry.register(adapter);
      expect(registry.get("claude")).toBe(adapter);
    });

    it("returns undefined for unknown adapter id", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("overwrites a previously registered adapter with the same id", () => {
      const first = makeFakeAdapter("dupe");
      const second = makeFakeAdapter("dupe");
      registry.register(first);
      registry.register(second);
      expect(registry.get("dupe")).toBe(second);
    });

    it("resolves canonical ID aliases bidirectionally (claude <-> claude-code, gemini <-> gemini-cli)", () => {
      const claude = makeFakeAdapter("claude");
      const gemini = makeFakeAdapter("gemini");
      registry.register(claude);
      registry.register(gemini);

      expect(registry.get("claude-code")).toBe(claude);
      expect(registry.get("gemini-cli")).toBe(gemini);

      registry.clear();

      const claudeCode = makeFakeAdapter("claude-code");
      const geminiCli = makeFakeAdapter("gemini-cli");
      registry.register(claudeCode);
      registry.register(geminiCli);

      expect(registry.get("claude")).toBe(claudeCode);
      expect(registry.get("gemini")).toBe(geminiCli);
    });
  });

  describe("list", () => {
    it("returns empty array when nothing registered", () => {
      expect(registry.list()).toEqual([]);
    });

    it("lists all registered adapter IDs", () => {
      registry.register(makeFakeAdapter("a"));
      registry.register(makeFakeAdapter("b"));
      expect(registry.list().toSorted()).toEqual(["a", "b"]);
    });
  });

  describe("detectAll", () => {
    it("returns adapters that detect successfully", async () => {
      registry.register(makeFakeAdapter("found", true));
      registry.register(makeFakeAdapter("missing", false));

      const detected = await registry.detectAll();
      expect(detected).toHaveLength(1);
      expect(detected[0]?.id).toBe("found");
    });

    it("skips adapters that throw during detection", async () => {
      const throwingAdapter = makeFakeAdapter("broken");
      throwingAdapter.detect = async () => {
        throw new Error("detection crashed");
      };
      registry.register(throwingAdapter);
      registry.register(makeFakeAdapter("stable", true));

      const detected = await registry.detectAll();
      expect(detected).toHaveLength(1);
      expect(detected[0]?.id).toBe("stable");
    });

    it("returns empty array when no adapters detect", async () => {
      registry.register(makeFakeAdapter("a", false));
      registry.register(makeFakeAdapter("b", false));

      const detected = await registry.detectAll();
      expect(detected).toEqual([]);
    });

    it("handles multiple throwing adapters gracefully", async () => {
      const spy = vi.fn();
      for (let i = 0; i < 3; i++) {
        const adapter = makeFakeAdapter(`throw-${i}`);
        adapter.detect = async () => {
          spy();
          throw new Error(`fail-${i}`);
        };
        registry.register(adapter);
      }

      const detected = await registry.detectAll();
      expect(detected).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(3);
    });
  });

  describe("clear", () => {
    it("removes all adapters", () => {
      registry.register(makeFakeAdapter("a"));
      registry.register(makeFakeAdapter("b"));

      registry.clear();

      expect(registry.list()).toEqual([]);
      expect(registry.get("a")).toBeUndefined();
      expect(registry.get("b")).toBeUndefined();
    });

    it("allows re-registration after clear", () => {
      registry.register(makeFakeAdapter("x"));
      registry.clear();
      registry.register(makeFakeAdapter("y"));

      expect(registry.list()).toEqual(["y"]);
      expect(registry.get("x")).toBeUndefined();
      expect(registry.get("y")?.id).toBe("y");
    });
  });
});
