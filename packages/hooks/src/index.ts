// ── Public API ────────────────────────────────────────────────
// The main entry point for ai-hooks.
//
// Usage:
//   import { defineConfig, hook, HookEngine } from "@itz4blitz/ai-tools-hooks";

// Config helpers (used in ai-hooks.config.ts)
export { defineConfig, hook } from "./config/index.js";
export { loadConfig, findConfigFile } from "./config/index.js";

// Runtime engine
export { HookEngine } from "./runtime/index.js";
export { executeChain, HookTimeoutError } from "./runtime/index.js";

// Adapter system
export { registry } from "./adapters/index.js";
export { BaseAdapter } from "./adapters/index.js";
export { runGrokHook } from "./adapters/grok-runner.js";
export { runZcodeHook } from "./adapters/zcode-runner.js";

// Built-in hooks
export {
  blockDangerousCommands,
  scanSecrets,
  protectGitignored,
  auditShellCommands,
  builtinHooks,
  guardAcceptanceWrite,
  noteUiSurface,
  recordAcceptanceEvidence,
  remindAcceptance,
  refuseUnprovenStop,
  acceptanceHooks,
} from "./hooks/index.js";
export { acceptanceSkeleton } from "./acceptance/acceptance.js";

// Types (re-export everything)
export type {
  // Events
  SessionStartEvent,
  SessionEndEvent,
  PromptSubmitEvent,
  PromptResponseEvent,
  ToolCallEvent,
  ToolResultEvent,
  FileReadEvent,
  FileWriteEvent,
  FileEditEvent,
  FileDeleteEvent,
  ShellBeforeEvent,
  ShellAfterEvent,
  McpCallEvent,
  McpResultEvent,
  NotificationEvent,
  BeforeEvent,
  AfterEvent,
  HookEvent,
  HookEventType,
  EventOf,
  // Hooks
  HookResult,
  HookContext,
  BeforeHookFn,
  AfterHookFn,
  HookDefinition,
  // Adapter
  AdapterCapabilities,
  GeneratedConfig,
  Adapter,
  AdapterFactory,
  // Config
  AiHooksConfig,
  ConfigSettings,
} from "./types/index.js";
export { isBeforeEvent } from "./types/index.js";

// Canonical store
export { CanonicalStore, Linker } from "./store/index.js";
export type { SerializedHookDefinition, LinkStatus } from "./store/index.js";
