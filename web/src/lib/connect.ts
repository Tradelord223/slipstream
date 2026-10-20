/**
 * Connection snippets for assistants. `origin` is where this Slipstream is reached, e.g. http://127.0.0.1:4380.
 * The server's `slipstream connect` command imports this file too, so the commands it prints and the ones
 * Settings shows can't drift apart.
 */

export const TOKEN_PLACEHOLDER = "<token>";

export const mcpUrl = (origin: string) => `${origin}/mcp`;

export const claudeCodeCommand = (origin: string, token = TOKEN_PLACEHOLDER) =>
  `claude mcp add --transport http slipstream ${mcpUrl(origin)} --header "Authorization: Bearer ${token}"`;

export type Cli = { command: string; args: string[] } | null | undefined;

const quote = (p: string) => (/[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

/** The stdio bridge as a program and arguments: absolute paths when known, since apps don't share your shell's PATH. */
const bridgeArgv = (cli: Cli) => (cli ? [cli.command, ...cli.args, "mcp"] : ["slipstream", "mcp"]);

/** Arguments to `claude` that add the stdio bridge for every project. No token appears: the bridge keeps its own. */
export const claudeCodeStdioArgs = (cli: Cli) => ["mcp", "add", "--scope", "user", "slipstream", "--", ...bridgeArgv(cli)];

/** Arguments to `codex` that add the stdio bridge to its MCP servers. */
export const codexStdioArgs = (cli: Cli) => ["mcp", "add", "slipstream", "--", ...bridgeArgv(cli)];

export const claudeCodeStdioCommand = (cli: Cli) => ["claude", ...claudeCodeStdioArgs(cli)].map(quote).join(" ");

export const codexStdioCommand = (cli: Cli) => ["codex", ...codexStdioArgs(cli)].map(quote).join(" ");

/** Claude Desktop/Cursor config. Absolute paths when the server knows them, since those apps don't share your shell's PATH. */
export const stdioConfig = (cli: Cli) =>
  JSON.stringify({ mcpServers: { slipstream: cli ? { command: cli.command, args: [...cli.args, "mcp"] } : { command: "slipstream", args: ["mcp"] } } }, null, 2);

export const curlCommand = (origin: string, token = TOKEN_PLACEHOLDER) => `curl -H "Authorization: Bearer ${token}" ${origin}/api/v1/commands`;

export const cliCommand = (cli: Cli) =>
  `${cli ? [cli.command, ...cli.args].map(quote).join(" ") : "slipstream"} mail.search --query "is:unread"`;

export const openApiUrl = (origin: string) => `${origin}/api/v1/openapi.json`;
