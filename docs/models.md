# Choose a model

Slipstream's agents can think with whichever model and account you already have. Pick one in **Settings → Models & accounts**, or switch per conversation from the assistant sidebar.

Whichever you choose, the agent works only through Slipstream's own commands. Scopes, the Review queue, attribution and undo are the same on every model, and each one acts under its own name ("ChatGPT", "Claude Code", "Gemini"…), so Activity and Review always say which one did what.

| | How you connect | Who pays | Runs where |
|---|---|---|---|
| **ChatGPT** | Sign in with your ChatGPT Plus or Pro account | Your ChatGPT plan's allowance | Slipstream calls OpenAI with your sign-in |
| **Claude Code** | Your own Claude Code, already signed in | Your Claude plan | Your Claude Code, on your computer |
| **Codex** | Your own Codex, already signed in | Your ChatGPT plan | Your Codex, on your computer |
| **Claude API** | An Anthropic API key | Your Anthropic account | Slipstream calls Anthropic |
| **OpenAI API** | An OpenAI API key | Your OpenAI account | Slipstream calls OpenAI |
| **Gemini** | A Google AI Studio API key | Your Google account | Slipstream calls Google |
| **OpenRouter** | An OpenRouter API key | Your OpenRouter credits | Slipstream calls OpenRouter (any tool-capable model) |
| **Claude (cloud)** | An Anthropic API key | Your Anthropic account | Anthropic's Managed Agents (see [agent-api.md](agent-api.md#the-cloud-agent-one-api-key)) |

## ChatGPT

**Continue with ChatGPT** uses OpenAI's open-source [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) flow. It works with Plus and Pro plans, and the agent's work draws on your plan's allowance. In ChatGPT **Settings → Usage** you choose how much of it Slipstream may use.

- Sign-in is a normal OAuth flow with PKCE. Slipstream listens on `127.0.0.1:1455` only while you sign in. Your tokens are stored encrypted on your own disk and refreshed automatically.
- **On a team server**, or when another app holds port 1455, the browser can't come back to Slipstream on its own. After signing in, the next page won't load. Copy the whole address from the address bar (it starts with `http://127.0.0.1:1455/auth/callback?`) and paste it into Slipstream within ten minutes.
- When you reach the limit you set, runs stop with "You've reached your ChatGPT usage limit" and pick up again once it resets.
- OpenAI labels this sign-in a preview, so it can change. An OpenAI API key is the steady alternative.

## Your own Claude Code or Codex

If Claude Code or Codex is installed and signed in on the computer running Slipstream, it shows up ready. Nothing to paste. Slipstream starts your own, unmodified program for each turn and never reads or copies its sign-in.

- **What it can touch:** each turn runs in a fresh, empty, private folder, with Slipstream's MCP server as its only connection.
  - **Claude Code:** built-in tools are off, and only Slipstream's tools are allowed.
  - **Codex:** its shell, hooks and command rules are switched off, and it runs read-only, without your own Codex config or other MCP servers. Codex plugins and apps, memories, browser use and computer use are off too. Slipstream also asks Codex to turn off sub-agents, but Codex 0.163.0 still lists its sub-agent tools; Codex runs read-only with no shell either way. Codex still reads your global `~/.codex/AGENTS.md`. If Slipstream can't ask your Codex which features it has (`codex features list`), it doesn't start Codex and says so.
- **The connection:** a token that works only on Slipstream's MCP endpoint, only for that turn, and is revoked when the turn ends.
- **What it sees of Slipstream's environment:** only what it needs to find its own sign-in, locale and proxy.
- **Billing:** API keys in Slipstream's environment are not passed to the program, so it uses your plan rather than billing an API account.
- **Claude Code terms:** Anthropic allows signing in to the unmodified Claude Code program with your own subscription, and usage counts against your plan. Its [terms](https://code.claude.com/docs/en/legal-and-compliance) have changed before; if they change again, the API-key route is unaffected.
- **Only when you pick them:** these engines run only when chosen, because being installed isn't the same as agreeing to spend your plan. They're also only available when Slipstream runs on your own computer, not on a team server.

## API keys

Paste a key in **Models & accounts**, or set it in Slipstream's environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `OPENROUTER_API_KEY`. Saved keys are encrypted on your own disk. Each card lists the models your key can use; Slipstream asks the provider rather than hard-coding names.

**Limits.** Each turn pauses after 25 tool calls; send a follow-up to let it continue. When a provider reports what a run cost (the managed Claude agent and OpenRouter), the per-run and monthly budgets in Models & accounts apply. OpenAI, Anthropic and Google report usage in tokens instead, so runs on those keys stop at 1.5 million tokens; set a spending limit in the provider's console as well. Every run shows the tokens it used.

## What Slipstream doesn't do

- **Reuse your claude.ai login.** Anthropic's terms don't allow apps to collect or route Claude account credentials. Use Claude Code or an API key.
- **"Sign in with Google" for Gemini plans.** Google's Gemini CLI terms prohibit other software from using its sign-in. Use a Gemini API key.
