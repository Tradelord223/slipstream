/** Connection snippets for assistants. `origin` is where this Slipstream is reached, e.g. http://127.0.0.1:4380. */

export const TOKEN_PLACEHOLDER = "<token>";

export const mcpUrl = (origin: string) => `${origin}/mcp`;

export const claudeCodeCommand = (origin: string, token = TOKEN_PLACEHOLDER) =>
  `claude mcp add --transport http slipstream ${mcpUrl(origin)} --header "Authorization: Bearer ${token}"`;

export const stdioConfig = `{
  "mcpServers": {
    "slipstream": { "command": "npx", "args": ["slipstream-mail", "mcp"] }
  }
}`;

export const curlCommand = (origin: string, token = TOKEN_PLACEHOLDER) => `curl -H "Authorization: Bearer ${token}" ${origin}/api/v1/commands`;

export const cliCommand = `npx slipstream-mail mail.search --query "is:unread"`;

export const openApiUrl = (origin: string) => `${origin}/api/v1/openapi.json`;
