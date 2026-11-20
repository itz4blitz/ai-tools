import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRun = vi.fn();

vi.mock("./index.js", () => ({
  run: mockRun,
}));

describe("cli bin entry point", () => {
  const originalError = console.error;
  const originalExit = process.exit;
  let errors: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    errors = [];
    exitCode = undefined;
    console.error = vi.fn((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    process.exit = vi.fn((code?: number) => {
      exitCode = code;
      return undefined as never;
    }) as never;
  });

  afterEach(() => {
    console.error = originalError;
    process.exit = originalExit;
  });

  it("prints Error.message and exits with 1 on Error rejection", async () => {
    mockRun.mockRejectedValueOnce(new Error("boom"));
    await import("./bin.js");
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toEqual(["boom"]);
    expect(exitCode).toBe(1);
  });

  it("stringifies non-Error throws and exits with 1", async () => {
    mockRun.mockRejectedValueOnce("plain string failure");
    await import("./bin.js");
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toEqual(["plain string failure"]);
    expect(exitCode).toBe(1);
  });
});
