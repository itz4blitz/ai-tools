import type { BaseSessionAdapter } from "./base.js";

const ID_ALIASES: Record<string, string> = {
  "claude-code": "claude",
  claude: "claude-code",
  "gemini-cli": "gemini",
  gemini: "gemini-cli",
};

class SessionAdapterRegistry {
  private adapters: Map<string, BaseSessionAdapter> = new Map();

  register(adapter: BaseSessionAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): BaseSessionAdapter | undefined {
    const direct = this.adapters.get(id);
    if (direct) return direct;
    const alias = ID_ALIASES[id];
    return alias ? this.adapters.get(alias) : undefined;
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }

  async detectAll(): Promise<BaseSessionAdapter[]> {
    const detected: BaseSessionAdapter[] = [];

    for (const adapter of this.adapters.values()) {
      try {
        const found = await adapter.detect();
        if (found) {
          detected.push(adapter);
        }
      } catch {
        // Detection failed, skip
      }
    }

    return detected;
  }

  clear(): void {
    this.adapters.clear();
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __itz4blitz_ai_sessions_registry: SessionAdapterRegistry | undefined;
}

export const registry = (globalThis.__itz4blitz_ai_sessions_registry ??=
  new SessionAdapterRegistry());
