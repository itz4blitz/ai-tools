import { hook } from "../config/define.js";
import type { HookDefinition } from "../types/index.js";

/**
 * Built-in hook: Block dangerous shell commands.
 * Prevents rm -rf /, drop database, and other destructive patterns.
 */
export const blockDangerousCommands = hook("before", ["shell:before"], async (ctx, next) => {
  const command = ctx.event.command;
  const dangerous = DANGEROUS_PATTERNS.find((p) => p.pattern.test(command));

  if (dangerous) {
    ctx.results.push({
      blocked: true,
      reason: `Blocked dangerous command: ${dangerous.description}`,
    });
    return;
  }

  await next();
})
  .id("ai-hooks:block-dangerous-commands")
  .name("Block Dangerous Commands")
  .description("Prevents destructive shell commands like rm -rf /, drop database, etc.")
  .priority(1)
  .build();

const DANGEROUS_PATTERNS = [
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s*$/, description: "rm -rf /" },
  { pattern: /rm\s+-[a-zA-Z]*f[a-zA-Z]*\s+~\/?\s*$/, description: "rm -rf ~" },
  { pattern: /mkfs\./, description: "filesystem format" },
  { pattern: /dd\s+.*of=\/dev\/[sh]d/, description: "disk overwrite" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, description: "fork bomb" },
  { pattern: />\s*\/dev\/[sh]d/, description: "device overwrite" },
  { pattern: /chmod\s+(-R\s+)?777\s+\//, description: "chmod 777 /" },
  { pattern: /DROP\s+DATABASE/i, description: "DROP DATABASE" },
  { pattern: /DROP\s+TABLE/i, description: "DROP TABLE" },
  { pattern: /TRUNCATE\s+TABLE/i, description: "TRUNCATE TABLE" },
];

/**
 * Built-in hook: Scan for secrets in file writes.
 * Detects API keys, tokens, and credentials being written to files.
 */
export const scanSecrets = hook("before", ["file:write", "file:edit"], async (ctx, next) => {
  const content = ctx.event.type === "file:write" ? ctx.event.content : ctx.event.newContent;

  const found = SECRET_PATTERNS.find((p) => p.pattern.test(content));

  if (found) {
    ctx.results.push({
      blocked: true,
      reason: `Potential secret detected: ${found.description}. Use environment variables instead.`,
    });
    return;
  }

  await next();
})
  .id("ai-hooks:scan-secrets")
  .name("Scan for Secrets")
  .description("Prevents hardcoded API keys, tokens, and credentials in file writes.")
  .priority(2)
  .build();

const SECRET_PATTERNS = [
  { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9]{20,}['"]/i, description: "API key" },
  {
    pattern: /(?:secret|token|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    description: "Secret/token/password",
  },
  { pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/, description: "Private key" },
  { pattern: /ghp_[a-zA-Z0-9]{36}/, description: "GitHub personal access token" },
  { pattern: /sk-[a-zA-Z0-9]{20,}/, description: "OpenAI/Stripe secret key" },
  { pattern: /AKIA[0-9A-Z]{16}/, description: "AWS access key ID" },
  { pattern: /xox[bpors]-[a-zA-Z0-9-]{10,}/, description: "Slack token" },
];

/**
 * Built-in hook: Protect sensitive files from being written, edited, or deleted.
 */
export const protectGitignored = hook(
  "before",
  ["file:write", "file:edit", "file:delete"],
  async (ctx, next) => {
    const path = ctx.event.path;

    // Block modifications or deletions of common sensitive files
    const sensitive = SENSITIVE_FILES.some((f) => path.endsWith(f));
    if (sensitive) {
      const action =
        ctx.event.type === "file:delete"
          ? "delete"
          : ctx.event.type === "file:edit"
            ? "edit"
            : "write to";
      ctx.results.push({
        blocked: true,
        reason: `Cannot ${action} sensitive file: ${path}. This file should be managed manually.`,
      });
      return;
    }

    await next();
  },
)
  .id("ai-hooks:protect-sensitive-files")
  .name("Protect Sensitive Files")
  .description(
    "Prevents AI tools from modifying or deleting .env, credentials, and other sensitive files.",
  )
  .priority(3)
  .build();

const SENSITIVE_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  "credentials.json",
  "service-account.json",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  ".pypirc",
];

/**
 * Built-in hook: Log all shell commands (after phase).
 */
export const auditShellCommands = hook("after", ["shell:after"], async (ctx, next) => {
  const { command, exitCode, duration } = ctx.event;
  ctx.results.push({
    data: {
      audit: {
        type: "shell",
        command,
        exitCode,
        duration,
        timestamp: ctx.event.timestamp,
        tool: ctx.tool.name,
      },
    },
  });
  await next();
})
  .id("ai-hooks:audit-shell")
  .name("Audit Shell Commands")
  .description("Records all shell command executions for audit trail.")
  .priority(999)
  .build();

/**
 * All built-in hooks as an array.
 * Use with `extends` in defineConfig to include defaults.
 */
export const builtinHooks: HookDefinition[] = [
  blockDangerousCommands,
  scanSecrets,
  protectGitignored,
  auditShellCommands,
];
