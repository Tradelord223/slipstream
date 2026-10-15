// A stand-in for the label commands (labels.*, labelRules.*) on servers that don't have them yet.
// It sits in front of a running Slipstream server: everything passes through untouched except those commands,
// which it answers from memory (colours, rules) and by calling the real triage endpoints for the mail itself.
//
//   node scripts/standin-labels.mjs <listen-port> <server-port>
//
// Delete it once the server answers labels.list.
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";

export function startLabelStandIn(listenPort, serverPort) {
  const target = `127.0.0.1:${serverPort}`;
  const colors = new Map();
  const extra = new Set();
  const rules = [];
  let nextRule = 1;

  const call = async (method, path, body) => {
    const res = await fetch(`http://${target}${path}`, {
      method,
      headers: { "x-slipstream": "1", "content-type": "application/json", origin: `http://${target}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  };
  const allThreads = async (q = "in:all") => (await call("GET", `/api/threads?view=search&q=${encodeURIComponent(q)}&limit=500`)).threads;
  const parentOf = (n) => (n.includes("/") ? n.slice(0, n.lastIndexOf("/")) : null);

  async function list() {
    const threads = await allThreads();
    const map = new Map();
    for (const name of extra) map.set(name.toLowerCase(), { name, count: 0, unread: 0 });
    for (const t of threads) {
      for (const l of t.labels) {
        const e = map.get(l.toLowerCase()) ?? { name: l, count: 0, unread: 0 };
        e.count += 1;
        if (t.unread) e.unread += 1;
        map.set(l.toLowerCase(), e);
      }
    }
    return [...map.values()].map((e) => ({ ...e, color: colors.get(e.name.toLowerCase()) ?? null, parent: parentOf(e.name) }));
  }

  const commands = {
    "labels.list": () => list(),
    "labels.create": async ({ name, color }) => {
      extra.add(name);
      if (color) colors.set(name.toLowerCase(), color);
      return { name };
    },
    "labels.update": async ({ name, newName, color }) => {
      if (color !== undefined) {
        if (color) colors.set((newName ?? name).toLowerCase(), color);
        else colors.delete((newName ?? name).toLowerCase());
      }
      if (newName && newName !== name) {
        const ids = (await allThreads(`label:"${name}"`)).map((t) => t.id);
        if (ids.length) {
          await call("POST", "/api/triage", { kind: "addLabel", threadIds: ids, label: newName });
          await call("POST", "/api/triage", { kind: "removeLabel", threadIds: ids, label: name });
        }
        if (extra.delete(name)) extra.add(newName);
        const c = colors.get(name.toLowerCase());
        if (c && color === undefined) colors.set(newName.toLowerCase(), c);
        colors.delete(name.toLowerCase());
      }
      return { name: newName ?? name };
    },
    "labels.delete": async ({ name }) => {
      const ids = (await allThreads(`label:"${name}"`)).map((t) => t.id);
      if (ids.length) await call("POST", "/api/triage", { kind: "removeLabel", threadIds: ids, label: name });
      extra.delete(name);
      colors.delete(name.toLowerCase());
      return { ok: true };
    },
    "labelRules.list": async () => rules,
    "labelRules.create": async ({ label, query, applyToExisting }) => {
      const rule = { id: `lrule_${nextRule++}`, label, query, enabled: true, createdAt: Date.now() };
      rules.push(rule);
      if (applyToExisting) {
        const ids = (await allThreads(query)).map((t) => t.id);
        if (ids.length) await call("POST", "/api/triage", { kind: "addLabel", threadIds: ids, label });
      }
      return rule;
    },
    "labelRules.update": async ({ id, ...patch }) => {
      const rule = rules.find((r) => r.id === id);
      if (!rule) throw Object.assign(new Error("Rule not found"), { status: 404 });
      Object.assign(rule, patch);
      return rule;
    },
    "labelRules.delete": async ({ id }) => {
      const i = rules.findIndex((r) => r.id === id);
      if (i >= 0) rules.splice(i, 1);
      return { ok: true };
    },
  };

  const server = createServer(async (req, res) => {
    const m = /^\/api\/v1\/(labels|labelRules)\.\w+$/.exec(req.url.split("?")[0]);
    const name = m && req.url.split("?")[0].slice("/api/v1/".length);
    if (name && commands[name] && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        const result = await commands[name](raw ? JSON.parse(raw) : {});
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "done", result, activityId: null }));
      } catch (err) {
        res.writeHead(err.status ?? 400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    const headers = { ...req.headers, host: target };
    if (headers.origin) headers.origin = `http://${target}`;
    const up = request({ host: "127.0.0.1", port: serverPort, path: req.url, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  return new Promise((resolve) => server.listen(listenPort, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startLabelStandIn(Number(process.argv[2]), Number(process.argv[3]));
  console.log(`label stand-in on ${process.argv[2]} -> ${process.argv[3]}`);
}
