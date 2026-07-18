/**
 * Parse mcpServers config strings into spawnable (key, command, args).
 *
 * Supported separators between server specs: `;` or newlines.
 * Spaces inside a command line are preserved for that command's argv.
 *
 * Examples:
 *   search=npx -y open-websearch@latest
 *   search=npx -y open-websearch@latest; fetch=npx -y some-fetch-mcp
 *
 * Broken (old) behavior split on every whitespace, turning the first example into
 * `search=npx` + orphan tokens — npx with zero args.
 */

export interface McpServerSpec {
  key: string;
  command: string;
  args: string[];
  rawCmd: string;
}

/** Split only on `;` / newlines so `npx -y pkg` stays one command. */
export function parseMcpServerSpecs(mcpServers: string): McpServerSpec[] {
  const chunks = mcpServers
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: McpServerSpec[] = [];
  for (const chunk of chunks) {
    const eq = chunk.indexOf("=");
    if (eq === -1) continue;
    const key = chunk.slice(0, eq).trim();
    const rawCmd = chunk.slice(eq + 1).trim();
    if (!key || !rawCmd) continue;
    const parts = rawCmd.split(/\s+/).filter(Boolean);
    const command = parts[0];
    if (!command) continue;
    out.push({ key, command, args: parts.slice(1), rawCmd });
  }
  return out;
}

/**
 * Env overlay for known MCP packages that need stdio-only mode.
 * Returns a clean string map for StdioClientTransport (no undefined values).
 */
export function mcpSpawnEnvForCmd(
  rawCmd: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (typeof v === "string") env[k] = v;
  }
  // open-websearch defaults to MODE=both (HTTP+stdio). Stdio MCP clients
  // need pure stdio or the process may bind HTTP / print noise on stdout.
  if (/open-websearch/i.test(rawCmd) && !env.MODE) {
    env.MODE = "stdio";
  }
  return env;
}
