import { describe, it, expect } from "vitest";
import {
  blockDangerousCommands,
  scanSecrets,
  protectGitignored,
  auditShellCommands,
  builtinHooks,
} from "./builtin.js";
import type { HookContext, HookEvent } from "../types/index.js";

function makeShellCtx(command: string): HookContext {
  return {
    event: {
      type: "shell:before",
      command,
      cwd: "/tmp",
      timestamp: Date.now(),
      metadata: {},
    } as HookEvent,
    tool: { name: "test", version: "1.0" },
    cwd: "/tmp",
    state: new Map(),
    results: [],
    startedAt: Date.now(),
  };
}

function makeFileWriteCtx(path: string, content: string): HookContext {
  return {
    event: {
      type: "file:write",
      path,
      content,
      timestamp: Date.now(),
      metadata: {},
    } as HookEvent,
    tool: { name: "test", version: "1.0" },
    cwd: "/tmp",
    state: new Map(),
    results: [],
    startedAt: Date.now(),
  };
}

function makeFileEditCtx(path: string, newContent: string): HookContext {
  return {
    event: {
      type: "file:edit",
      path,
      oldContent: "",
      newContent,
      timestamp: Date.now(),
      metadata: {},
    } as HookEvent,
    tool: { name: "test", version: "1.0" },
    cwd: "/tmp",
    state: new Map(),
    results: [],
    startedAt: Date.now(),
  };
}

function makeFileDeleteCtx(path: string): HookContext {
  return {
    event: {
      type: "file:delete",
      path,
      timestamp: Date.now(),
      metadata: {},
    } as HookEvent,
    tool: { name: "test", version: "1.0" },
    cwd: "/tmp",
    state: new Map(),
    results: [],
    startedAt: Date.now(),
  };
}

function makeShellAfterCtx(command: string): HookContext {
  return {
    event: {
      type: "shell:after",
      command,
      cwd: "/tmp",
      exitCode: 0,
      stdout: "output",
      stderr: "",
      duration: 150,
      timestamp: Date.now(),
      metadata: {},
    } as HookEvent,
    tool: { name: "claude", version: "2.0" },
    cwd: "/tmp",
    state: new Map(),
    results: [],
    startedAt: Date.now(),
  };
}

const noop = async () => {};

describe("blockDangerousCommands", () => {
  it("blocks rm -rf /", async () => {
    const ctx = makeShellCtx("rm -rf /");
    await blockDangerousCommands.handler(ctx, noop);
    expect(ctx.results).toHaveLength(1);
    expect(ctx.results[0]?.blocked).toBe(true);
    expect(ctx.results[0]?.reason).toContain("rm -rf /");
  });

  it("blocks DROP DATABASE", async () => {
    const ctx = makeShellCtx('psql -c "DROP DATABASE production"');
    await blockDangerousCommands.handler(ctx, noop);
    expect(ctx.results).toHaveLength(1);
    expect(ctx.results[0]?.blocked).toBe(true);
  });

  it("blocks DROP TABLE", async () => {
    const ctx = makeShellCtx("DROP TABLE users");
    await blockDangerousCommands.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
  });

  it("blocks fork bomb", async () => {
    const ctx = makeShellCtx(":() { :|:& } ;:");
    await blockDangerousCommands.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
  });

  it("allows safe commands", async () => {
    let nextCalled = false;
    const ctx = makeShellCtx("ls -la");
    await blockDangerousCommands.handler(ctx, async () => {
      nextCalled = true;
    });
    expect(ctx.results).toHaveLength(0);
    expect(nextCalled).toBe(true);
  });

  it("allows npm install", async () => {
    let nextCalled = false;
    const ctx = makeShellCtx("npm install express");
    await blockDangerousCommands.handler(ctx, async () => {
      nextCalled = true;
    });
    expect(ctx.results).toHaveLength(0);
    expect(nextCalled).toBe(true);
  });

  it("has correct metadata", () => {
    expect(blockDangerousCommands.id).toBe("ai-hooks:block-dangerous-commands");
    expect(blockDangerousCommands.phase).toBe("before");
    expect(blockDangerousCommands.priority).toBe(1);
    expect(blockDangerousCommands.events).toEqual(["shell:before"]);
  });
});

describe("scanSecrets", () => {
  it("blocks hardcoded API keys in file writes", async () => {
    const ctx = makeFileWriteCtx("config.ts", 'const apiKey = "ABCDEF1234567890ABCDEF1234567890"');
    await scanSecrets.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
    expect(ctx.results[0]?.reason).toContain("API key");
  });

  it("blocks private keys", async () => {
    const ctx = makeFileWriteCtx("key.pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIE...");
    await scanSecrets.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
    expect(ctx.results[0]?.reason).toContain("Private key");
  });

  it("blocks GitHub tokens", async () => {
    const ctx = makeFileWriteCtx(
      "config.ts",
      "const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';",
    );
    await scanSecrets.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
  });

  it("blocks AWS access keys", async () => {
    const ctx = makeFileWriteCtx("aws.ts", 'const key = "AKIAIOSFODNN7EXAMPLE";');
    await scanSecrets.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
  });

  it("blocks secrets in file edits (newContent)", async () => {
    const ctx = makeFileEditCtx(
      "config.ts",
      'const secret = "sk-proj-very-secret-key-that-is-long"',
    );
    await scanSecrets.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
  });

  it("allows normal code", async () => {
    let nextCalled = false;
    const ctx = makeFileWriteCtx("index.ts", 'const greeting = "hello world";');
    await scanSecrets.handler(ctx, async () => {
      nextCalled = true;
    });
    expect(ctx.results).toHaveLength(0);
    expect(nextCalled).toBe(true);
  });

  it("allows env variable references", async () => {
    let nextCalled = false;
    const ctx = makeFileWriteCtx("config.ts", "const key = process.env.API_KEY;");
    await scanSecrets.handler(ctx, async () => {
      nextCalled = true;
    });
    expect(ctx.results).toHaveLength(0);
    expect(nextCalled).toBe(true);
  });
});

describe("protectGitignored", () => {
  it("blocks writes to .env", async () => {
    const ctx = makeFileWriteCtx("/project/.env", "SECRET=value");
    await protectGitignored.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
    expect(ctx.results[0]?.reason).toContain(".env");
  });

  it("blocks writes to .env.local", async () => {
    const ctx = makeFileWriteCtx("/project/.env.local", "KEY=value");
    await protectGitignored.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
  });

  it("blocks writes to credentials.json", async () => {
    const ctx = makeFileWriteCtx("/project/credentials.json", "{}");
    await protectGitignored.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
  });

  it("blocks writes to id_rsa", async () => {
    const ctx = makeFileWriteCtx("/home/user/.ssh/id_rsa", "key");
    await protectGitignored.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
  });

  it("allows writes to normal files", async () => {
    let nextCalled = false;
    const ctx = makeFileWriteCtx("src/index.ts", "export {}");
    await protectGitignored.handler(ctx, async () => {
      nextCalled = true;
    });
    expect(ctx.results).toHaveLength(0);
    expect(nextCalled).toBe(true);
  });

  it("blocks edits to sensitive files", async () => {
    const ctx = makeFileEditCtx("/project/.env", "SECRET=updated");
    await protectGitignored.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
    expect(ctx.results[0]?.reason).toContain("edit");
    expect(ctx.results[0]?.reason).toContain(".env");
  });

  it("blocks deletions of sensitive files", async () => {
    const ctx = makeFileDeleteCtx("/project/credentials.json");
    await protectGitignored.handler(ctx, noop);
    expect(ctx.results[0]?.blocked).toBe(true);
    expect(ctx.results[0]?.reason).toContain("delete");
    expect(ctx.results[0]?.reason).toContain("credentials.json");
  });

  it("subscribes to file:write, file:edit, and file:delete", () => {
    expect(protectGitignored.events).toEqual(["file:write", "file:edit", "file:delete"]);
  });
});

describe("auditShellCommands", () => {
  it("records shell command audit data", async () => {
    let nextCalled = false;
    const ctx = makeShellAfterCtx("npm test");
    await auditShellCommands.handler(ctx, async () => {
      nextCalled = true;
    });
    expect(ctx.results).toHaveLength(1);
    expect(ctx.results[0]?.data?.audit).toBeDefined();
    const audit = ctx.results[0]?.data?.audit as Record<string, unknown>;
    expect(audit.command).toBe("npm test");
    expect(audit.exitCode).toBe(0);
    expect(audit.duration).toBe(150);
    expect(audit.tool).toBe("claude");
    expect(nextCalled).toBe(true);
  });

  it("has correct metadata", () => {
    expect(auditShellCommands.phase).toBe("after");
    expect(auditShellCommands.priority).toBe(999);
    expect(auditShellCommands.events).toEqual(["shell:after"]);
  });
});

describe("builtinHooks", () => {
  it("contains all 4 built-in hooks", () => {
    expect(builtinHooks).toHaveLength(4);
    const ids = builtinHooks.map((h) => h.id);
    expect(ids).toContain("ai-hooks:block-dangerous-commands");
    expect(ids).toContain("ai-hooks:scan-secrets");
    expect(ids).toContain("ai-hooks:protect-sensitive-files");
    expect(ids).toContain("ai-hooks:audit-shell");
  });
});
