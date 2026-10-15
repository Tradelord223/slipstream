// A stand-in for Anthropic's Managed Agents API, for trying the cloud agent without a real key.
// It speaks just enough of the protocol (environments, agents, sessions, the event stream) for the server's
// SLIPSTREAM_ANTHROPIC_BASE_URL setting to point at it, and plays a small script in place of the model:
// the agent searches the mail, writes a draft, asks to send it (which waits in Review), then reports.
//
//   node scripts/fake-managed-agents.mjs [port]      # prints the URL to use as SLIPSTREAM_ANTHROPIC_BASE_URL
//
// Behaviour by what the instruction says:
//   "waiting on me"      the agent starts, then stays busy forever (a run you can Stop)
//   "Priya" / "reply"    search, draft a reply, ask to send it, report
//   "costly"             finishes like any run but reports a $1.50 bill
//   anything else        searches and reports
// An API key equal to "sk-bad" is refused with a 401.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const COSTS = [
  [/costly/i, 150],
  [/newsletters/i, 22],
  [/invoices/i, 31],
  [/kettleby/i, 46],
];

export class FakeManagedAgents {
  constructor({ badKey = "sk-bad" } = {}) {
    this.badKey = badKey;
    this.calls = [];
    this.agentVersion = 0;
    this.sessions = new Map();
    this.server = createServer((req, res) => void this.handle(req, res));
    this.url = "";
  }

  async listen(port = 0) {
    await new Promise((r) => this.server.listen(port, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this.url;
  }

  close() {
    for (const s of this.sessions.values()) for (const l of s.listeners) l.end();
    this.server.close();
  }

  emit(sid, event) {
    const s = this.sessions.get(sid);
    const full = { id: `sevt_${s.events.length + 1}`, processed_at: new Date().toISOString(), ...event };
    s.events.push(full);
    for (const l of s.listeners) l.write(`event: ${full.type}\ndata: ${JSON.stringify(full)}\n\n`);
  }

  say(sid, text) {
    this.emit(sid, { type: "agent.message", content: [{ type: "text", text }] });
  }

  tool(sid, name, input) {
    this.emit(sid, { type: "agent.custom_tool_use", name, input });
    this.emit(sid, { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: [] } });
  }

  finish(sid) {
    this.emit(sid, { type: "session.status_idle", stop_reason: { type: "end_turn" } });
  }

  /** One step of the script, run when the session starts and after each tool result. */
  advance(sid, last) {
    const s = this.sessions.get(sid);
    const n = s.step++;
    const parse = () => {
      try {
        return JSON.parse(last);
      } catch {
        return {};
      }
    };
    if (s.kind === "hold") {
      if (n === 0) {
        this.say(sid, "I'll go through everyone waiting on you.");
        this.tool(sid, "mail_search", { query: "is:unread in:inbox", limit: 10 });
      } else if (n === 1) {
        this.say(sid, "Reading the most recent ones now.");
        this.tool(sid, "mail_list", { view: "inbox", limit: 5 });
      }
      return; // and then it keeps working
    }
    if (s.kind === "reply") {
      if (n === 0) {
        this.say(sid, "I'll start with Priya's thread.");
        this.tool(sid, "mail_search", { query: "from:priya", limit: 5 });
      } else if (n === 1) {
        const thread = (parse().threads ?? [])[0];
        if (!thread) {
          this.say(sid, "- I couldn't find a conversation from Priya.");
          return this.finish(sid);
        }
        s.threadId = thread.id;
        this.tool(sid, "drafts_create", {
          threadId: thread.id,
          body: "Hi Priya,\n\nThursday at 10 works. I'll bring the round 2 dashboard notes and we can go through the lane grouping together.\n\nSee you then,\nJordan",
        });
      } else if (n === 2) {
        const draftId = parse().id;
        if (!draftId) {
          this.say(sid, "- I wrote the reply but couldn't save it as a draft.");
          return this.finish(sid);
        }
        this.tool(sid, "drafts_send", { draftId });
      } else {
        this.say(sid, "- Found Priya's thread about Thursday.\n- Drafted a reply confirming Thursday at 10.\n- The send is waiting for your OK in Review.");
        this.finish(sid);
      }
      return;
    }
    if (n === 0) {
      this.tool(sid, "mail_search", { query: "newer:14d", limit: 5 });
    } else {
      const found = (parse().threads ?? []).length;
      this.say(sid, found > 0 ? `- Looked through ${found} recent conversations.\n- Nothing needed changing.` : "- Nothing matched.");
      this.finish(sid);
    }
  }

  async handle(req, res) {
    const url = new URL(req.url, "http://x");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    this.calls.push({ method: req.method, path: url.pathname, body });
    const json = (o, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (req.headers["x-api-key"] === this.badKey) {
      return json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401);
    }
    const p = url.pathname;
    if (req.method === "POST" && p === "/v1/environments") return json({ id: "env_1", type: "environment", name: body.name });
    if (req.method === "POST" && p === "/v1/agents") return json({ id: "agent_1", type: "agent", version: ++this.agentVersion, ...body });
    if (req.method === "POST" && p === "/v1/agents/agent_1") return json({ id: "agent_1", type: "agent", version: ++this.agentVersion });
    if (req.method === "POST" && p === "/v1/sessions") {
      const sid = `sesn_${this.sessions.size + 1}`;
      const text = body.initial_events?.[0]?.content?.[0]?.text ?? "";
      const kind = /waiting on me/i.test(text) ? "hold" : /priya|reply/i.test(text) ? "reply" : "plain";
      const cost = COSTS.find(([re]) => re.test(text))?.[1] ?? 37;
      this.sessions.set(sid, { events: [], listeners: new Set(), step: 0, kind, cost });
      for (const e of body.initial_events ?? []) this.emit(sid, e);
      setTimeout(() => this.advance(sid), 400);
      return json({ id: sid, type: "session", status: "running" });
    }
    const m = /^\/v1\/sessions\/(sesn_\d+)(\/events(\/stream)?)?$/.exec(p);
    if (m) {
      const s = this.sessions.get(m[1]);
      if (m[3]) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        s.listeners.add(res);
        req.on("close", () => s.listeners.delete(res));
        return;
      }
      if (m[2] && req.method === "GET") return json({ data: s.events, next_page: null });
      if (m[2] && req.method === "POST") {
        for (const e of body.events) {
          this.emit(m[1], e);
          if (e.type === "user.custom_tool_result") setTimeout(() => this.advance(m[1], e.content[0].text), 350);
          if (e.type === "user.message" && s.step > 0 && s.kind !== "hold") {
            setTimeout(() => {
              this.say(m[1], "- Done. Anything else?");
              this.finish(m[1]);
            }, 300);
          }
        }
        return json({ data: [] });
      }
      return json({ id: m[1], type: "session", status: "idle", usage: { list_cost: { amount: String(s.cost), currency: "USD" } } });
    }
    res.writeHead(404).end("{}");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fake = new FakeManagedAgents();
  const url = await fake.listen(Number(process.argv[2]) || 0);
  console.log(url);
  process.on("SIGTERM", () => (fake.close(), process.exit(0)));
}
