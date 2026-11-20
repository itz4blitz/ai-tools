import type { MCPServerDefinition } from "./types/index.js";

export type AuditKind =
  | "project-server-in-user-config"
  | "secret-wrapper-in-user-config"
  | "org-pattern-in-user-config";

export type AuditFinding = {
  tool: string;
  server: string;
  kind: AuditKind;
  detail: string;
};

export type AuditRuleOptions = {
  /** Server IDs that must only live in project-level configs, never user-global configs. */
  projectOnlyIds?: string[];
  /** Substrings (org names, internal domains, repo/path fragments) forbidden in user-global configs. */
  forbiddenPatterns?: string[];
  /** Command prefixes/fragments representing interactive secret wrappers. Default: ["op-run"]. */
  secretWrapperPatterns?: string[];
  /** Environment variable names that indicate an interactive secret-manager account. Default: ["OP_ACCOUNT"]. */
  secretEnvVars?: string[];
  /** Command suffixes exempt from secret-wrapper checks (e.g. headless service accounts). Default: ["-sa"]. */
  allowlistedWrapperSuffixes?: string[];
};

const DEFAULT_SECRET_WRAPPER_PATTERNS = ["op-run"];
const DEFAULT_SECRET_ENV_VARS = ["OP_ACCOUNT"];
const DEFAULT_ALLOWLISTED_SUFFIXES = ["-sa"];

function getCommandBasename(command: string): string {
  const normalized = command.replaceAll("\\", "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export function auditServers(
  tool: string,
  servers: MCPServerDefinition[],
  source: "user" | "project" = "user",
  options: AuditRuleOptions = {},
): AuditFinding[] {
  const projectOnlyIds = new Set(options.projectOnlyIds ?? []);
  const forbiddenPatterns = (options.forbiddenPatterns ?? []).filter((p) => p.length > 0);
  const secretWrapperPatterns = options.secretWrapperPatterns ?? DEFAULT_SECRET_WRAPPER_PATTERNS;
  const secretEnvVars = options.secretEnvVars ?? DEFAULT_SECRET_ENV_VARS;
  const allowlistedSuffixes = options.allowlistedWrapperSuffixes ?? DEFAULT_ALLOWLISTED_SUFFIXES;

  const findings: AuditFinding[] = [];

  for (const server of servers) {
    const command = server.transport.type === "stdio" ? server.transport.command : "";
    const args = server.transport.type === "stdio" ? (server.transport.args ?? []) : [];
    const env = server.transport.type === "stdio" ? (server.transport.env ?? {}) : {};
    const url = "url" in server.transport ? server.transport.url : "";

    const basename = getCommandBasename(command);
    const isAllowlistedWrapper = allowlistedSuffixes.some((suffix) => basename.endsWith(suffix));
    const matchedWrapper =
      !isAllowlistedWrapper &&
      secretWrapperPatterns.find(
        (pattern) =>
          basename === pattern ||
          basename.startsWith(`${pattern}-`) ||
          basename.startsWith(`${pattern}_`),
      );
    const matchedEnvVar = secretEnvVars.find((key) => Boolean(env[key]));

    if (source === "user" && (matchedWrapper || matchedEnvVar)) {
      const reason = matchedWrapper
        ? `command wrapper "${basename}"`
        : `env ${matchedEnvVar}=${matchedEnvVar ? env[matchedEnvVar] : ""}`;
      findings.push({
        tool,
        server: server.id,
        kind: "secret-wrapper-in-user-config",
        detail: `${server.id} uses an interactive secret wrapper in a user-global config (${reason})`,
      });
    }

    const isProjectScoped =
      server.layer === "project" ||
      (server.whenPathContains !== undefined && server.whenPathContains.length > 0) ||
      projectOnlyIds.has(server.id);

    if (source === "user" && isProjectScoped) {
      findings.push({
        tool,
        server: server.id,
        kind: "project-server-in-user-config",
        detail: `${server.id} is a project-scoped MCP server configured in a user-global config`,
      });
    }

    if (source === "user" && forbiddenPatterns.length > 0) {
      const searchable = [server.id, server.name, command, ...args, url, ...Object.values(env)]
        .join("\n")
        .toLowerCase();
      for (const pattern of forbiddenPatterns) {
        if (searchable.includes(pattern.toLowerCase())) {
          findings.push({
            tool,
            server: server.id,
            kind: "org-pattern-in-user-config",
            detail: `${server.id} matches restricted pattern "${pattern}" in a user-global config`,
          });
          break;
        }
      }
    }
  }

  return findings;
}
