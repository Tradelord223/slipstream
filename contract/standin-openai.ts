import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

/**
 * A stand-in for OpenAI's Responses API that behaves like a sensible mail agent: it does the
 * assistant's task (search, draft, ask to send), sorts Autopilot batches (machines out, people kept,
 * replies needed), and drafts replies. Used by the contract suite, and for local demos without a key:
 *
 *   node contract/standin-openai.ts 4390
 *   OPENAI_API_KEY=stand-in SLIPSTREAM_OPENAI_BASE_URL=http://127.0.0.1:4390/v1 npm run dev
 */

type Item = { type?: string; role?: string; content?: unknown; call_id?: string; output?: string; name?: string; arguments?: string };

/** The model: decides what to do next from the conversation so far, like a sensible agent would. */
function nextStep(input: Item[]): Item[] {
  const lastUser = input.map((i) => i.role).lastIndexOf("user");
  const ask = String(input[lastUser]!.content);
  const outputs = input.slice(lastUser + 1).filter((i) => i.type === "function_call_output").map((i) => i.output!);
  const call = (name: string, args: unknown): Item => ({ type: "function_call", call_id: `call_${outputs.length}_${name}`, name, arguments: JSON.stringify(args) });
  const say = (text: string): Item => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

  if (ask.includes("<conversation id=")) {
    if (outputs.length) return [say("Sorted.")];
    const ids = [...ask.matchAll(/<conversation id="([^"]+)" category="([^"]+)"/g)].map((m) => ({ id: m[1]!, category: m[2]! }));
    return [
      call("autopilot_decide", {
        decisions: ids.map((c) =>
          c.category === "important"
            ? { threadId: c.id, action: "keep", needsReply: true, summary: "Someone wrote to you", reason: "A person is waiting on you", confidence: 0.9 }
            : { threadId: c.id, action: "done", priority: "low", summary: "Automated mail", reason: "Sent by a machine; nothing to do", confidence: 0.9 },
        ),
      }),
    ];
  }
  if (ask.startsWith("You are Autopilot, drafting")) {
    const first = /^Conversation (\S+):/m.exec(ask)![1]!;
    if (outputs.length === 0) return [call("mail_read", { threadId: first })];
    if (outputs.length === 1) return [call("drafts_create", { threadId: first, body: "Thanks. [time] works for me." })];
    return [say("Drafted one reply.")];
  }
  if (outputs.length === 0) return [call("mail_search", { query: "Dispatch", limit: 1 })];
  if (outputs.length === 1) return [call("drafts_create", { threadId: JSON.parse(outputs[0]!).threads[0].id, body: "Thanks, that works for us." })];
  if (outputs.length === 2) return [call("drafts_send", { draftId: JSON.parse(outputs[1]!).id })];
  return [say("Drafted a reply and asked you to approve sending it.")];
}

export function standInOpenAI() {
  const requests: { model: string; store: boolean; tools: { name: string }[] }[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] }));
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { model: string; store: boolean; input: Item[]; tools: { name: string }[] };
    requests.push(body);
    const items = nextStep(body.input);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const item of items) res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
    res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { output: items, usage: { input_tokens: 100, output_tokens: 20 } } })}\n\n`);
  });
  return { server, requests };
}


if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.argv[2] ?? 4390);
  standInOpenAI().server.listen(port, "127.0.0.1", () => console.log(`Stand-in Responses API on http://127.0.0.1:${port}/v1`));
}
