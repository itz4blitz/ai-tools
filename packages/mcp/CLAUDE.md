# packages/mcp

MCP (Model Context Protocol) server configuration management. Simpler than hooks — no runtime engine, no event system. Just manages server definitions across tools.

## Key Types (`types/definition.ts`)

`MCPServerDefinition`: `id`, `name`, `description?`, `transport`, `enabled?`, `tags?`

Two transport types (plus `http`, which adapters map to native URL/remote forms):

- `{ type: "stdio", command: string, args?: string[], env?: Record<string, string> }`
- `{ type: "sse" | "http", url: string, headers?: Record<string, string> }`

Servers may set `layer: "user" | "project"` (default project) and `whenPathContains` so project-scoped MCPs install only in matching repos. `ai-mcp audit` scans user-global configs for interactive secret wrappers and project-scoped servers that leaked out of project scope.

Config: `MCPConfig { servers: MCPServerDefinition[] }`

## Adapter Pattern

Much simpler than hooks (~44-line base). No event mapping. Adapters:

- `detect()` — check if tool is installed
- `generate(servers)` — produce tool-specific config files (e.g., `.mcp.json` for Claude Code)
- `install()` — write generated files
- `import()` — read existing tool configs back to universal format

The Claude Code adapter reads/writes `.mcp.json` with a `mcpServers` object structure.

## CLI Commands

`init`, `detect`, `generate`, `install`, `import`, `sync`, `export`, `help`

The `import` and `sync` commands are the primary use case — syncing MCP server configs across multiple AI tools.
