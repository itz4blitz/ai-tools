import { describe, expect, it } from "vitest";
import {
  encodeMcpToml,
  mergeMcpToml,
  parseMcpToml,
  stripMcpTomlTables,
  tomlKey,
} from "./toml-mcp.js";
import type { MCPServerDefinition } from "./types/index.js";

const stdio: MCPServerDefinition = {
  id: "context7",
  name: "context7",
  transport: {
    type: "stdio",
    command: "/usr/local/bin/mcp-runner",
    args: ["npx", "-y", "@upstash/context7-mcp"],
    env: { CONTEXT7_API_KEY: "secret-token-value" },
  },
};

const spaced: MCPServerDefinition = {
  id: "Acme - Workspace Tools",
  name: "Acme - Workspace Tools",
  transport: { type: "stdio", command: "/usr/local/bin/acme-workspace-mcp" },
};

const remote: MCPServerDefinition = {
  id: "linear",
  name: "linear",
  transport: {
    type: "http",
    url: "https://mcp.linear.app/mcp",
    headers: { Authorization: "Bearer token" },
  },
};

describe("tomlKey", () => {
  it("leaves bare keys unquoted", () => {
    expect(tomlKey("acme_tools")).toBe("acme_tools");
  });

  it("quotes names with spaces", () => {
    expect(tomlKey("Acme - Workspace Tools")).toBe('"Acme - Workspace Tools"');
  });

  it("escapes quotes, backslashes, and control characters in keys", () => {
    expect(tomlKey('a "b"\\c')).toBe('"a \\"b\\"\\\\c"');
  });
});

describe("encodeMcpToml / parseMcpToml", () => {
  it("round-trips stdio servers with env tables", () => {
    const encoded = encodeMcpToml([stdio]);
    expect(encoded).toContain("[mcp_servers.context7]");
    expect(encoded).toContain("[mcp_servers.context7.env]");
    expect(encoded).toContain('command = "/usr/local/bin/mcp-runner"');
    expect(parseMcpToml(encoded)).toEqual([
      {
        id: "context7",
        name: "context7",
        transport: stdio.transport,
        enabled: undefined,
      },
    ]);
  });

  it("round-trips quoted table names", () => {
    const encoded = encodeMcpToml([spaced]);
    expect(encoded).toContain('[mcp_servers."Acme - Workspace Tools"]');
    expect(parseMcpToml(encoded)[0]?.id).toBe("Acme - Workspace Tools");
  });

  it("round-trips escaped quotes, backslashes, and newlines/tabs/CR", () => {
    const tricky: MCPServerDefinition = {
      id: 'server "alpha"\\1',
      name: 'server "alpha"\\1',
      transport: {
        type: "stdio",
        command: "C:\\tools\\bin\\",
        args: ['say "hi"', "line1\nline2\r\tindented", "a,b,c"],
        env: { NOTE: 'val\\"\n\t' },
      },
    };
    const encoded = encodeMcpToml([tricky]);
    expect(encoded).toContain("\\n");
    expect(encoded).toContain("\\r");
    expect(encoded).toContain("\\t");
    expect(parseMcpToml(encoded)).toEqual([tricky]);
  });

  it("parses quoted commas inside args arrays", () => {
    const parsed = parseMcpToml(`[mcp_servers.csv]
command = "node"
args = ["--cols", "a,b,c", "x, y"]
`);
    expect(parsed[0]?.transport).toEqual({
      type: "stdio",
      command: "node",
      args: ["--cols", "a,b,c", "x, y"],
    });
  });

  it("parses multiline arrays with trailing commas and inline comments", () => {
    const parsed = parseMcpToml(`[mcp_servers.multi] # server comment
command = "npx" # binary
args = [
  "-y", # auto confirm
  "@org/pkg,v2",
  'C:\\tools\\run.exe', # literal windows path
]
`);
    expect(parsed[0]?.transport).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@org/pkg,v2", "C:\\tools\\run.exe"],
    });
  });

  it("parses single-quoted literal strings without unescaping backslashes", () => {
    const parsed = parseMcpToml(`[mcp_servers.win]
command = 'C:\\Program Files\\Tool\\bin.exe' # inline comment
args = ['--dir', 'C:\\Users\\dev\\#work']
`);
    expect(parsed[0]?.transport).toEqual({
      type: "stdio",
      command: "C:\\Program Files\\Tool\\bin.exe",
      args: ["--dir", "C:\\Users\\dev\\#work"],
    });
  });

  it("preserves # inside double-quoted strings while stripping trailing inline comments", () => {
    const parsed = parseMcpToml(`[mcp_servers.hash]
url = "https://example.com/mcp#frag" # trailing comment
`);
    expect(parsed[0]?.transport).toEqual({
      type: "http",
      url: "https://example.com/mcp#frag",
    });
  });

  it("round-trips http servers with headers", () => {
    const encoded = encodeMcpToml([remote]);
    expect(encoded).toContain('url = "https://mcp.linear.app/mcp"');
    expect(parseMcpToml(encoded)[0]?.transport).toEqual(remote.transport);
  });

  it("parses inline env and headers tables from host files", () => {
    const parsed = parseMcpToml(`[mcp_servers.filesystem]
command = "npx"
args = ["-y", "server"]
env = { API_KEY = "secret", OTHER = "x,y", WIN_PATH = 'C:\\bin\\tool.exe' }

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
headers = { "Authorization" = "Bearer token", "x-mcp-session-id" = "{{session_id}}" }
`);
    expect(parsed.find((s) => s.id === "filesystem")?.transport).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "server"],
      env: { API_KEY: "secret", OTHER: "x,y", WIN_PATH: "C:\\bin\\tool.exe" },
    });
    expect(parsed.find((s) => s.id === "linear")?.transport).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer token", "x-mcp-session-id": "{{session_id}}" },
    });
  });

  it("parses Codex http_headers as transport headers", () => {
    const parsed = parseMcpToml(`[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
http_headers = { "X-Figma-Region" = "us-east-1" }
`);
    expect(parsed[0]?.transport).toEqual({
      type: "http",
      url: "https://mcp.figma.com/mcp",
      headers: { "X-Figma-Region": "us-east-1" },
    });
  });

  it("parses nested http_headers tables", () => {
    const parsed = parseMcpToml(`[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"

[mcp_servers.figma.http_headers]
X-Figma-Region = "us-east-1"
`);
    expect(parsed[0]?.transport).toEqual({
      type: "http",
      url: "https://mcp.figma.com/mcp",
      headers: { "X-Figma-Region": "us-east-1" },
    });
  });

  it("parses empty inline env without treating it as a command env", () => {
    const parsed = parseMcpToml(`[mcp_servers.x]
command = "x"
env = {}
`);
    expect(parsed[0]?.transport).toEqual({ type: "stdio", command: "x" });
  });

  it("encodes Codex HTTP remotes with http_headers tables", () => {
    const encoded = encodeMcpToml([remote], { headerTable: "http_headers" });
    expect(encoded).toContain("[mcp_servers.linear.http_headers]");
    expect(encoded).toContain('Authorization = "Bearer token"');
    expect(parseMcpToml(encoded)[0]?.transport).toEqual(remote.transport);
  });

  it("encodes enabled = false", () => {
    const encoded = encodeMcpToml([{ ...stdio, enabled: false }]);
    expect(encoded).toContain("enabled = false");
    expect(parseMcpToml(encoded)[0]?.enabled).toBe(false);
  });

  it("returns empty string for no servers", () => {
    expect(encodeMcpToml([])).toBe("");
    expect(parseMcpToml("")).toEqual([]);
  });
});

describe("mergeMcpToml", () => {
  it("preserves unrelated tables and replaces managed MCP servers", () => {
    const existing = `[ui]
yolo = false

[mcp_servers.acme]
command = "/old/acme"

[mcp_servers.homelab]
command = "/usr/local/bin/uvx"
`;
    const merged = mergeMcpToml(
      existing,
      [{ id: "github", name: "github", transport: { type: "stdio", command: "gh-mcp" } }],
      ["acme", "github"],
    );
    expect(merged).toContain("[ui]");
    expect(merged).toContain("yolo = false");
    expect(merged).toContain("[mcp_servers.homelab]");
    expect(merged).toContain("[mcp_servers.github]");
    expect(merged).not.toContain("acme");
  });

  it("preserves unmanaged mcp_servers blocks verbatim including Codex/Grok fields and comments", () => {
    const existing = `model = "gpt-5"

[mcp_servers.managed_old]
command = "old-bin"

# Custom unmanaged server
[mcp_servers.custom_remote]
url = "https://custom.example.com/mcp"
bearer_token_env_var = "CUSTOM_TOKEN"
env_http_headers = { "X-Env-Key" = "MY_ENV_KEY" }
cwd = "/workspace/app"
startup_timeout_sec = 30
tool_timeout_sec = 120
enabled_tools = ["search", "fetch"] # keep this comment
`;
    const merged = mergeMcpToml(
      existing,
      [{ id: "github", name: "github", transport: { type: "stdio", command: "gh-mcp" } }],
      ["managed_old", "github"],
      { headerTable: "http_headers" },
    );

    expect(merged).not.toContain("managed_old");
    expect(merged).toContain("# Custom unmanaged server");
    expect(merged).toContain('bearer_token_env_var = "CUSTOM_TOKEN"');
    expect(merged).toContain('env_http_headers = { "X-Env-Key" = "MY_ENV_KEY" }');
    expect(merged).toContain('cwd = "/workspace/app"');
    expect(merged).toContain("startup_timeout_sec = 30");
    expect(merged).toContain("tool_timeout_sec = 120");
    expect(merged).toContain('enabled_tools = ["search", "fetch"] # keep this comment');
    expect(merged).toContain("[mcp_servers.github]");
  });

  it("strips mcp_servers tables without stripping mcp_servers_extra", () => {
    const stripped = stripMcpTomlTables(`[ui]
yolo = true

[mcp_servers.x]
command = "x"

[mcp_servers_extra]
enabled = true

[mcp_servers_extra.custom]
foo = "bar"
`);
    expect(stripped).toContain("[ui]");
    expect(stripped).not.toContain("[mcp_servers.x]");
    expect(stripped).toContain("[mcp_servers_extra]");
    expect(stripped).toContain("[mcp_servers_extra.custom]");
    expect(stripped).toContain('foo = "bar"');
  });

  it("re-encodes Codex merges with http_headers", () => {
    const merged = mergeMcpToml('model = "gpt-5"\n', [remote], ["linear"], {
      headerTable: "http_headers",
    });
    expect(merged).toContain('model = "gpt-5"');
    expect(merged).toContain("[mcp_servers.linear.http_headers]");
    expect(merged).not.toContain("[mcp_servers.linear.headers]");
  });

  it("preserves [[array_of_tables]] after stripped mcp_servers and prevents field bleed on parse", () => {
    const source = `[mcp_servers.managed_old]
command = "old-bin"

[[projects]]
command = "not-an-mcp-command"
url = "https://project.example.com"
enabled = false
name = "web"
`;
    const parsed = parseMcpToml(source);
    expect(parsed).toEqual([
      {
        id: "managed_old",
        name: "managed_old",
        transport: { type: "stdio", command: "old-bin" },
      },
    ]);

    const merged = mergeMcpToml(
      source,
      [{ id: "github", name: "github", transport: { type: "stdio", command: "gh-mcp" } }],
      ["managed_old", "github"],
    );
    expect(merged).not.toContain("managed_old");
    expect(merged).toContain("[[projects]]");
    expect(merged).toContain('name = "web"');
    expect(merged).toContain("[mcp_servers.github]");
  });
});
