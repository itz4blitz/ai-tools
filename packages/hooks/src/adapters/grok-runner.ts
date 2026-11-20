import { loadConfig } from "../config/index.js";
import { HookEngine } from "../runtime/index.js";
import type { AiHooksConfig } from "../types/index.js";
import {
  buildCompatEvent,
  isBlockingNativeEvent,
  payloadEventName,
  type CompatPayload,
} from "./claude-compat.js";

export type HookRunnerIO = {
  stdin?: string | AsyncIterable<Buffer | string>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  config?: AiHooksConfig;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
};

export async function readStdinText(
  stdin?: string | AsyncIterable<Buffer | string>,
): Promise<string> {
  if (typeof stdin === "string") return stdin;
  const stream = stdin ?? process.stdin;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function parseCompatPayload(raw: string): CompatPayload {
  try {
    return JSON.parse(raw || "{}") as CompatPayload;
  } catch {
    return {};
  }
}

/**
 * Execute configured ai-hooks for a Grok command hook.
 * Grok sends JSON on stdin and honors {"decision":"deny"} plus exit 2.
 */
export async function runGrokHook(io: HookRunnerIO = {}): Promise<number> {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  try {
    const raw = await readStdinText(io.stdin);
    const payload = parseCompatPayload(raw);
    const nativeEvent = payloadEventName(payload, env.GROK_HOOK_EVENT);
    const event = buildCompatEvent(nativeEvent, payload, "grok");
    if (!event) return 0;

    const config = io.config ?? (await loadConfig(undefined, io.cwd));
    const engine = new HookEngine(config);
    const results = await engine.emit(event, { name: "grok", version: "1.0" });
    const blocked = results.find((result) => result.blocked);
    if (blocked && isBlockingNativeEvent(nativeEvent)) {
      stdout.write(
        JSON.stringify({
          decision: "deny",
          reason: blocked.reason ?? "Blocked by ai-hooks",
        }),
      );
      return 2;
    }

    const contextNotes = results
      .map((result) => result.data?.additionalContext)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (contextNotes.length > 0) {
      stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: nativeEvent,
            additionalContext: contextNotes.join("\n"),
          },
        }),
      );
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`[ai-hooks] Error: ${message}\n`);
    return 0;
  }
}
