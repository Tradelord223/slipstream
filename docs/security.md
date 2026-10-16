# Security and privacy

Slipstream holds the keys to people's mailboxes. This page covers who it defends against and how.

## Threats and defenses

**A website you visit tries to talk to your local Slipstream.**

- **Network exposure:** local mode listens on 127.0.0.1 only.
- **DNS rebinding:** every request must carry an allowed `Host` header, or it gets a 421 response.
- **Cross-site requests:** API calls need a custom `x-slipstream` header. Browsers can't send it cross-origin without a CORS preflight, and Slipstream never approves one.
- **Origin check:** requests with a foreign `Origin` are refused.

**A malicious email tries to run code, track you, or phish through the UI.**

- **Sanitizing:** HTML bodies are sanitized with DOMPurify, which removes scripts, forms, frames and event handlers.
- **Sandboxing:** designed messages render in a sandboxed `srcdoc` iframe with no `allow-scripts` and a strict Content-Security-Policy.
- **Remote images:** held back until you choose to show them, so a tracking pixel can't tell the sender you opened the message.
- **Attachments:** downloads are served as `application/octet-stream` with `Content-Disposition: attachment` and a sandbox CSP. Only raster images render inline.

The details, and the test that proves them, are in [How Slipstream shows an email](#how-slipstream-shows-an-email).

**A malicious email tries to hijack the AI** (prompt injection).

Assume some mail will try. Slipstream's defenses are enforced by the server, not by asking a model to behave:

- **Quick summaries and reply suggestions get no tools at all.** They can't fetch URLs, send mail or read other mail. Their output is shown as plain text, and a suggested reply only ever lands in your compose box.
- **Agents act only through Slipstream's commands,** with the scopes you gave them. Sending, bulk deletion and settings changes wait for you in Review by default, and everything else is attributed and undoable.
- **Autopilot is boxed in per run:**
  - It has its own agent with read, triage and draft access, never send.
  - A sorting run may read only the conversations in its batch and record decisions about them.
  - A drafting run may read only its conversations and reply to the people who wrote; the server sets the recipients, not the model.
  - The server refuses anything else, whatever the email says.
- **Data, not instructions:** email content (bodies, subjects, names and addresses) goes to a model as marked data with no angle brackets left in it, so it can't pose as Slipstream's own instructions.
- **Your own Claude Code or Codex** runs in an empty private folder with Slipstream's MCP server as its only tool source: Claude Code's built-in tools are off, and Codex's shell, hooks and command rules are off. Its token works only on `/mcp`, only for that turn. It sees only the environment variables it needs for its own sign-in.

**Sender logos reveal who you hear from.**

- **Off by default.** Logos show next to company senders only after you turn them on in Settings. On a team server, `SLIPSTREAM_SENDER_LOGOS=off` switches them off for everyone.
- **What is fetched, and by whom.** The computer running Slipstream (your own Mac in local mode, the server in team mode) looks for each company's icon on the company's own website, about once a month per company. Your browser never contacts those sites.
- **What a sender's site can learn.** That someone running Slipstream asked for its icon. It can't tell which message prompted it or who the message was for, and the request happens at a random time hours later, not when the mail arrives.
- **Guarded requests.** The server only makes plain https requests on port 443 and refuses any address inside your own network or the internet's reserved ranges, including after redirects. Downloaded images are checked by their contents, and SVG logos are stripped down to plain shapes before they are stored.
- **No lookups on demand.** Only senders who have actually written to you get a logo, a request for any other domain is refused, and the demo mailbox uses built-in invented logos without any network access.
- **Other web pages can't ask.** Logos load only for Slipstream's own pages. A request from any other site, or from a browser that doesn't say where a request came from, gets nothing, so a web page can't probe which companies email you.
- **Teammates can't learn from each other.** On a team server each person waits out their own random delay before seeing a logo, even when a teammate's request already fetched it, so how fast a logo appears says nothing about anyone else's mail.

**Someone gets a copy of the database.**

- **Encryption:** sealed with AES-256-GCM are the sign-in tokens and passwords for your mail accounts (OAuth refresh tokens, IMAP passwords), saved AI keys and sign-ins, the cloud agent's key and webhook signing secrets. The key comes from `SLIPSTREAM_SECRET` or a separate 0600 key file (`secret.key`) in the same data folder.
- **Not encrypted:** your messages, contacts, labels, drafts and attachments are stored as ordinary files (`slipstream.db` and `blobs/`). Slipstream doesn't encrypt them, so rely on your disk's encryption.
- **What sealing covers:** a copy of the database alone doesn't reveal your mail-account credentials. A copy of the whole data folder does, unless you set `SLIPSTREAM_SECRET` and keep it elsewhere.
- **Permissions:** the data folder is created owner-only (0700) and files are created owner-only (umask 077).

**Team mode: an outsider or a teammate oversteps.**

- **Sign-up:** after the first owner, joining needs an invite link. Links are single-use, expire in 14 days and can be bound to an email address.
- **Passwords:** hashed with scrypt (N=2^15). Login and sign-up attempts are rate-limited.
- **Sessions:** HttpOnly, SameSite=Lax, and Secure under HTTPS.
- **Data access:** every query is scoped to the signed-in user's own accounts. Teammates only ever see snapshots someone deliberately shared.
- **Snippets:** shared snippets can be edited only by their author.

**OAuth flows.** Slipstream uses PKCE. The `state` value is random, single-use, expires after 10 minutes and is bound to the user who started the flow.

## How Slipstream shows an email

An email is a web page written by a stranger, so Slipstream treats it as hostile. This is done in your browser by `web/src/lib/emailHtml.ts` and `web/src/components/EmailBody.tsx`. Each statement below is checked by `npm run test:render`, described at the end.

**1. It's cleaned first.** Every HTML message goes through DOMPurify, set to an allowlist of ordinary formatting tags.

- **Removed:** scripts, event-handler attributes (`onclick`, `onerror` and the rest), forms and form controls, iframes and frames, `object` and `embed`, SVG and MathML, audio, video, `canvas`, `dialog`, and the `link`, `meta` and `base` tags. The attributes `srcset`, `ping`, `formaction` and `data-*` go too.
- **Links:** only `http:`, `https:`, `mailto:` and `tel:` links keep their address. A `javascript:`, `data:`, `file:` or relative link becomes plain text.
- **Images:** an `<img>` keeps its source only if it is a picture attached to the message (`cid:`), an `https:` picture you have allowed, or a small inline `data:image/` picture. Any other source is removed.
- **Plain-text mail** is escaped, never parsed as HTML.

**2. Two ways of showing it.**

- **Simple messages** (paragraphs, lists, links and quotes; no tables, `<style>` blocks or design colours and fonts) are shown in the page itself, with all inline styles removed.
- **Designed messages** are shown on a white page inside a sandboxed iframe.

**3. The frame.**

- **Sandbox:** `allow-same-origin allow-popups allow-popups-to-escape-sandbox`. There is no `allow-scripts`, `allow-forms` or `allow-top-navigation`, so the message can't run script, submit a form or move Slipstream to another page. Same-origin is there so Slipstream can measure the message and size the frame; without scripts the message can't use it.
- **Content policy:** `default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; font-src data:`. In words: no scripts, frames, media, plugins or connections of any kind, only inline styles, and pictures only from inline `data:` addresses and from Slipstream itself (the message's own attachments). When you allow images, `https:` is added to the picture sources and nothing else changes.
- **Referrer:** the frame has `referrerpolicy="no-referrer"`.

**4. Remote images are held back.**

- Remote `<img>` sources, `background` attributes and CSS `url()` values pointing at `http:`, `https:` or `//` addresses are removed or swapped for an empty picture. Literal `@import` rules are removed whether or not images are allowed.
- Slipstream counts what it held back. If there's anything, it shows "Images are hidden to keep your reading private" with **Show images** and **Always for this sender**.
- The frame's content policy is a second wall. It refuses what the cleaning doesn't recognise: `image-set("https://…")` strings, a quoted address that contains `)`, and CSS escapes such as `\75 rl(` or `@\69mport`, which the cleaning doesn't decode. These only occur in designed messages, which are the ones shown in the frame. The test counts these refusals, and none of them reaches the network.

**5. After you allow images.**

- **Show images** applies to that message, in that view only.
- **Always for this sender** is stored in this browser's `localStorage` (key `ss-image-senders`, the latest 500 senders). It never goes to the Slipstream server and isn't synced, so another browser or profile asks again.
- **Settings → General → Remote images → Always show** applies to all mail. It's saved with your other settings on the Slipstream server and is off by default (Ask first).
- **What loads:** pictures over `https:`. That includes `<img>` tags and the pictures a message's styles refer to (backgrounds, borders, masks, cursors, list bullets, `content:` images and similar). Plain `http:` pictures never load.
- **What never loads:** fonts, style sheets, frames, audio, video, scripts and plugins.
- The server hosting a picture can still see your IP address and when you opened the message. That is what you agree to by allowing images.

**6. Reply and forward.** The quoted message goes through the same cleaning with its images and `<style>` blocks removed, and the editor drops `style` and `background` attributes. Opening a reply or forward loads nothing from the original sender.

**7. Links.** Every link gets `target="_blank"` and `rel="noopener noreferrer"`, in both ways of showing a message. The new tab can't reach back into Slipstream and the site gets no `Referer` header. Slipstream doesn't rewrite or check where a link goes, so a link that carries the sender's tracking code still tells them you clicked.

**8. Attachments.** The download link points at `/api/attachments/<id>`. The server answers with `content-type: application/octet-stream`, `content-disposition: attachment` and `content-security-policy: default-src 'none'; sandbox`, so the browser saves the file instead of opening it. The one exception is a message's own inline picture (`?inline=1`) whose type is PNG, JPEG, GIF, WebP, AVIF or BMP. SVG is never shown inline. Slipstream doesn't scan attachments for viruses.

### What the test proves

`npm run test:render` builds the real `EmailBody` and `ComposeEditor` into a small page and shows each message in `web/test-fixtures/hostile-emails` in headless Chromium, once with images held back and once after **Show images**, then again as a reply and a forward. It needs a headless Chromium: set `CHROME_PATH` if it can't find one, and it fails (rather than skips) when there's none.

The messages cover scripts and event handlers; `javascript:` and `data:` links and images; tracking pixels over http, https and `//`; `<style>` with `@import`, `url()`, `image-set()`, `@font-face`, `@namespace`, `content`, `list-style-image`, `cursor`, `border-image` and masks; CSS escapes and comment splitting; the old `background` and `bgcolor` attributes; `<picture>`, `<video poster>`, `<audio>`; `<link>`, `<meta http-equiv="refresh">` and `<base href>`; frames, `srcdoc`, `object`, `embed` and forms; SVG and MathML (including `<image>` and `<use>`); sanitizer-confusion markup; image maps; and `cid:` pictures.

Every address in them points at a local test server that counts what reaches it, and nothing else can be reached. For each message the test asserts:

- **Images held back:** no request to any other origin, no connection to the test server, no script run (a flag every hostile script would set), no dialog, no new tab, and no navigation of the page or the frame.
- **Images allowed:** every request that reaches the server is an `https:` picture; none is plain `http:`, a font, a style sheet or a frame.
- **Rendered markup:** no script, frame, form, plugin or event handler survives, and every link and image-map area has a safe address, `target="_blank"` and `rel="noopener noreferrer"`.
- **Frame:** the sandbox, referrer policy and content policy are exactly the ones above.
- **Choices:** **Always for this sender** makes no call to the Slipstream server and writes only to this browser; **Show images** is not remembered; a fresh browser profile asks again.
- **Clicks:** a link opens a new tab with no `window.opener` and no `Referer` header.
- **Control:** an unsanitized page loaded the same way is caught by the recorder, the dialog listener and the script flag, so a clean run is meaningful.

What it doesn't cover: other browsers (it runs Chromium), messages beyond these examples, a future flaw in DOMPurify or the browser, and what a sender can learn from an image you chose to allow. The test page has no content policy of its own, so it is stricter than the real app. `expected.json` records how each message is shown and the pictures it may load after **Show images**. Loading a picture that isn't on the reviewed list fails the test, and a normal newsletter must still load all of its pictures. The list is a ceiling rather than an exact match, because which style-referenced pictures a browser fetches varies a little between versions. After a deliberate change, review the output and refresh the list with `npm run test:render -- --update`.

## What an AI model sees

Nothing, until you turn something on. Slipstream sends mail text to a model only through these, each of which uses the model or key you chose:

- **Summaries and reply drafts** need an Anthropic key (in Settings, or `ANTHROPIC_API_KEY` in the server's environment). They run only when you press the button, send that conversation's text (newest messages first, up to about 120,000 characters, quoted history trimmed) and give the model no tools.
- **The assistant, routines and the cloud agent** read mail through Slipstream's commands, within the scopes you gave them. What they read goes to their model's provider. The server honours the assistant switch in Settings → AI: with it off, no chat or routine starts and Autopilot reads no new mail (`409 The assistant is off`). Agents you connect yourself over MCP, the API or the CLI are not part of that switch.
- **One-time codes** are masked in everything above, in summaries and drafts, and in the subjects the assistant and routines are told. An agent's searches can't be used to guess one either: a search that matches message text never returns a conversation with a code in it.
- **Autopilot** is off until you turn it on. For each new message it sends the sender, subject, recipients (the first five), date, header facts and the opening of the text (1,500 characters, or 300 for bulk mail). To draft a reply it reads that conversation and samples of your earlier sent mail.
- **Your own agent** (Claude Code, Codex or any MCP client) reads whatever its token's scopes allow.

Nothing is sent to Slipstream's authors. See [models.md](models.md) and [autopilot.md](autopilot.md) for how each is set up.

## What Slipstream never does

- **No read receipts or tracking pixels** in mail you send.
- **No analytics, telemetry, error reporting or remote fonts.** The web app loads nothing from third parties.
- **No contact with Slipstream's authors.** There's no server to talk to.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue.
