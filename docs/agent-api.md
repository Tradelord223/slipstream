# Agents

Slipstream is built for people and their AI agents together. Anything you can do in the dashboard, an agent can do through the same command registry. You can see everything an agent did, approve what's risky, and undo the rest.

## How it fits together

- **One vocabulary.** About 40 commands (`mail.search`, `mail.read`, `triage.done`, `triage.remind`, `drafts.create`, `drafts.send`, `team.comment`, `undo`, …) live in one registry. The HTTP API, the MCP tools, the CLI and the dashboard's command palette are all generated from it, so they can't drift apart.
- **Agents are principals.** Each agent has a name, a token and scopes:

  | Scope | Lets the agent |
  |---|---|
  | `read` | search and read mail |
  | `triage` | done, remind, labels, trash |
  | `draft` | write drafts, comment for the team |
  | `send` | send mail |
  | `settings` | change splits and snippets |

  Tokens are shown once and stored hashed. Revoking an agent cuts it off immediately.
- **Approvals.** Each agent has a policy that decides what waits for you in **Review**:
  - **Sending:** always waits by default. You can loosen it to "only outside my domain" or "never".
  - **Bulk trash or spam:** over 10 conversations at once waits for approval.
  - **Settings changes:** wait by default.

  You approve with Enter and reject with Backspace.
- **Activity and undo.** Every action is recorded with who did it, from your own keystrokes to each agent's. An agent's actions also show at the top of the conversation they touched ("Inbox agent marked this done · Undo"). Undo is exact within the triage window, and after that it runs the opposite action.

## Agents built in

The assistant sidebar, routines and [Autopilot](autopilot.md) run on the model you choose: ChatGPT, your own Claude Code or Codex, or a Claude, OpenAI, Gemini or OpenRouter key. See [models.md](models.md). Each acts as its own agent with the same scopes, approvals and undo described here.

## The cloud agent (one API key)

Want an agent without running one? Open **Agent** in the sidebar and paste an Anthropic API key. Slipstream sets up Claude on Anthropic's Managed Agents, and its only tools are Slipstream's own commands. Anthropic runs the agent loop and Slipstream answers each tool call. So the cloud agent:

- **uses the same rules as any other agent:** scopes, approvals, attribution and undo, under the name "Claude (cloud)";
- **needs no public address:** it never reaches your mail directly, and never sees a password or token;
- **works on demand:** type "Ask Claude…" in the Agent page or the command palette, and watch the run live;
- **runs routines:**
  - on a schedule ("Weekdays at 8:00: triage the inbox and draft replies to people waiting on me");
  - when new mail matches a search ("When `from:@client.com` arrives: draft a reply");
- **has hard budgets:** each run has a dollar cap enforced by Anthropic ($1 by default), and Slipstream stops starting runs once the month's spend reaches your limit ($20 by default).

It runs Claude Opus 5.5. Your key is stored encrypted on your own disk. Runs happen while Slipstream is running, which on a laptop means while it's awake; a team server runs routines around the clock. Disconnecting revokes the agent in Slipstream. The agent definition stays in your Anthropic Console, where you can archive it.

## Give an agent access

Settings → Agents → **New agent**. Choose the scopes and the approval policy, then copy the token.

### Claude Code, Cursor and other HTTP MCP clients

```bash
claude mcp add --transport http slipstream http://127.0.0.1:4380/mcp \
  --header "Authorization: Bearer ss_agent_…"
```

### Claude Desktop and other stdio MCP clients

```json
{ "mcpServers": { "slipstream": { "command": "slipstream", "args": ["mcp"] } } }
```

Settings → Connect shows this snippet with the full paths for your machine, which you'll want when the app launching it (Claude Desktop, for example) doesn't share your terminal's PATH. On a local install, `slipstream mcp` creates its own agent ("Local MCP") the first time it runs, and it appears in Settings → Agents. Elsewhere, set `SLIPSTREAM_URL` and `SLIPSTREAM_TOKEN`. The bridge goes through the running server, so its actions are attributed, scoped and approvable like any other agent's.

### HTTP API

```bash
curl -H "Authorization: Bearer ss_agent_…" http://127.0.0.1:4380/api/v1/commands
curl -H "Authorization: Bearer ss_agent_…" -H "content-type: application/json" \
  -d '{"query":"is:unread from:@client.com"}' http://127.0.0.1:4380/api/v1/mail.search
```

- Every command is `POST /api/v1/<command>` with a JSON body.
- The OpenAPI 3.1 description is at `/api/v1/openapi.json`.
- Results come back as `{ "status": "done", "result": …, "activityId": … }`. An action waiting for approval returns HTTP 202 with `{ "status": "pending_approval", "approvalId": … }`.
- Agent tokens can only reach `/api/v1`, `/api/events` (server-sent events) and `/mcp`. They can't reach the dashboard's own API.

### Command line

```bash
slipstream commands                       # list everything
slipstream mail.search --query "is:unread" --limit 5
slipstream triage.remind --threadIds '["thr_…"]' --until 2026-10-16T09:00:00-04:00
slipstream drafts.create --threadId thr_… --body "Sounds good — Thursday works."
slipstream mail.read --help               # a command's input schema
```

`drafts.create` and `drafts.send` results carry `warnings`, a list of plain sentences. When a recipient is a no-reply address (`no-reply@`, `noreply@`, `do-not-reply@` ...) it has one line, such as `no-reply@example.com doesn't accept replies.` A warning never blocks the draft or the send.

### Searching all of a person's mail

`mail.search` looks at what Slipstream has on this machine: summaries (headers and a short preview) of the last 30 days, and the full text of the newest inbox mail and anything opened lately. `mail.searchAll` (scope `read`) asks each account's own provider instead, so it finds older mail and words deep inside a message.

```bash
slipstream mail.searchAll --query "from:@lumenridge.com lease" --limit 10
```

- **Same search language.** Free words, `from:`, `to:`, `subject:`, `has:attachment`, `after:`, `before:`, `newer:` and `older:` are translated for Gmail, Outlook (Microsoft Graph) and IMAP servers (Gmail over IMAP uses Gmail's own query language). Operators that only exist in Slipstream (`is:`, `label:`, `category:`, `in:`, `cc:`, `filename:`) are not sent; they narrow what the provider finds, and the result lists them in `localOnly` with a `note`. A search made only of those returns nothing from this command; use `mail.search`.
- **Results are stored.** Every hit becomes an ordinary conversation holding just its summary, so `mail.read`, `triage.*` and the dashboard work on it like any other. Mail Slipstream already has is left exactly as it is.
- **Paging.** Up to 50 results per account per page (`limit`, default 25), newest first. When `next` is set, pass it back as `pageToken`. Pass `account` to search one account only.
- **One account failing doesn't fail the call.** An account that errors or doesn't answer within about 8 seconds is named in `failures` with a plain reason, the other accounts' results are returned, and `next` asks the failed account again.
- **One-time codes stay hidden.** Codes are masked in every row, as everywhere. A provider matches words against the whole message, though, and a stored summary was only checked for codes in its preview. So when the search has words, `mail.searchAll` first reads each hit in full, then leaves out every conversation that carries a code, and any conversation it couldn't read. A search with only `from:`, `to:`, dates and the like returns code conversations, masked, as `mail.search` does.
- **People can use it too.** The dashboard asks the same way when you search: local results appear at once, and a quiet line at the end says it is searching your whole mailbox at Gmail, Outlook or your mail server.

### Webhooks

Settings → Agents → Webhooks. Choose the events you want: `threads`, `drafts`, `activity`, `approval`, `sync`, `import`, or everything. Each delivery carries two headers:

```
X-Slipstream-Timestamp: 1792094400
X-Slipstream-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
```

Check the signature and reject old timestamps. Failed deliveries are retried with backoff. On a team server, webhook targets must be public HTTPS addresses.

## Connect claude.ai, ChatGPT and other cloud assistants

Cloud assistants call your MCP endpoint from their own servers, so they need an address on the internet, and they sign in with OAuth. Slipstream includes a small OAuth server, and you don't need any hosting.

1. Install [Tailscale](https://tailscale.com/download) and sign in.
2. In Settings → Agents → **Connect an assistant**, turn on **Anywhere (Tailscale Funnel)**. Copy the MCP URL, for example `https://your-mac.tail1234.ts.net/mcp`.
3. Add it as a custom connector in claude.ai, or as an app or connector in ChatGPT.
4. The assistant opens a Slipstream page that shows a pairing code. In Slipstream → Review, approve the request with the same code.

The connection becomes an agent with `read`, `triage` and `draft` access. You can add `send`, change its policy or revoke it like any other agent.

**Your own devices only.** Use **Tailscale Serve** instead. It gives the same HTTPS address, but only devices on your tailnet can reach it. That's right for Claude Code, Cursor or Claude Desktop on your other machines, connected with a bearer token.

### What's exposed

- Serve and Funnel point at a second loopback listener (port 4381 by default). It serves only:
  - `/mcp`
  - `/oauth/*`
  - `/.well-known/oauth-*`
- The dashboard and its API are never reachable from outside.
- Every MCP request needs a token: an agent token, or a short-lived OAuth access token (one hour, with rotating refresh tokens).
- A connection request can't do anything until you approve it, and at most five can wait at once.

A team server already has a public HTTPS address, so it serves the same OAuth and `/mcp` endpoints on its own domain. Signing in there uses the team member's own session.

**Other tunnels work too.** Use ngrok or a Cloudflare named tunnel pointed at `http://127.0.0.1:4381`, and set `SLIPSTREAM_REMOTE_URL` to the public origin.

## Safety model

Email is written by strangers, and agents read it. Slipstream assumes some of that mail will try to steer your agents:

- **Data, not instructions.** Tool descriptions and results mark message content as untrusted third-party data.
- **Sending needs you.** Sending, bulk deletion and settings changes need your approval by default, whatever the agent was told.
- **Scopes are enforced by the server.** An agent never sees tools it isn't allowed to use.
- **Everything is visible and reversible.** Every action is attributed and can be undone, and revoking an agent takes effect at once.
- **The built-in AI is boxed in.** Summaries and reply drafts have no tools at all.
