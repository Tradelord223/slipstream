/** Connection snippets for assistants. `origin` is where this Slipstream is reached, e.g. http://127.0.0.1:4380. */

export const TOKEN_PLACEHOLDER = "<token>";

export const mcpUrl = (origin: string) => `${origin}/mcp`;

export const claudeCodeCommand = (origin: string, token = TOKEN_PLACEHOLDER) =>
  `claude mcp add --transport http slipstream ${mcpUrl(origin)} --header "Authorization: Bearer ${token}"`;

type Cli = { command: string; args: string[] } | null | undefined;

/** Claude Desktop/Cursor config. Absolute paths when the server knows them, since those apps don't share your shell's PATH. */
export const stdioConfig = (cli: Cli) =>
  JSON.stringify({ mcpServers: { slipstream: cli ? { command: cli.command, args: [...cli.args, "mcp"] } : { command: "slipstream", args: ["mcp"] } } }, null, 2);

export const curlCommand = (origin: string, token = TOKEN_PLACEHOLDER) => `curl -H "Authorization: Bearer ${token}" ${origin}/api/v1/commands`;

const quote = (p: string) => (/[\s"']/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p);

export const cliCommand = (cli: Cli) =>
  `${cli ? [cli.command, ...cli.args].map(quote).join(" ") : "slipstream"} mail.search --query "is:unread"`;

export const openApiUrl = (origin: string) => `${origin}/api/v1/openapi.json`;
