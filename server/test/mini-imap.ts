/**
 * A small real IMAP server (plaintext, loopback) over the FakeServer's mailboxes, so ImapProvider can be driven
 * through the real imapflow client. It speaks just the commands the provider uses: LOGIN, ENABLE, LIST, LSUB,
 * SELECT/EXAMINE, UID SEARCH, FETCH/UID FETCH (with CHANGEDSINCE), UID STORE (flags and X-GM-LABELS), UID MOVE,
 * CREATE, SUBSCRIBE, APPEND, NOOP, CLOSE, LOGOUT. Anything else gets BAD.
 */
import net from "node:net";
import type { FakeBox, FakeMessage, FakeServer } from "./fake-imap.ts";
import { headerBlock, partBytes, structureOf, structureWire } from "./mime-fake.ts";

type Token = string | Token[];

/** Split a command line into atoms, quoted strings and nested lists. Literals arrive as "\0L<n>" placeholders. */
function tokenize(text: string): Token[] {
  const stack: Token[][] = [[]];
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === " ") i++;
    else if (ch === "(") {
      const list: Token[] = [];
      stack[stack.length - 1]!.push(list);
      stack.push(list);
      i++;
    } else if (ch === ")") {
      stack.pop();
      i++;
    } else if (ch === '"') {
      let s = "";
      i++;
      while (text[i] !== '"') {
        if (text[i] === "\\") i++;
        s += text[i++];
      }
      i++;
      stack[stack.length - 1]!.push(s);
    } else {
      let s = "";
      while (i < text.length && text[i] !== " " && text[i] !== "(" && text[i] !== ")") s += text[i++];
      stack[stack.length - 1]!.push(s);
    }
  }
  return stack[0]!;
}

function uidSet(set: string, max: number): ((uid: number) => boolean) {
  const ranges = set.split(",").map((part) => {
    const [a, b] = part.split(":");
    const lo = a === "*" ? max : Number(a);
    const hi = b === undefined ? lo : b === "*" ? max : Number(b);
    return [Math.min(lo, hi), Math.max(lo, hi)] as const;
  });
  return (n) => ranges.some(([lo, hi]) => n >= lo && n <= hi);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const imapDate = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} +0000`;

/** The data items of a FETCH command line, split at the top level so `BODY.PEEK[HEADER.FIELDS (A B)]<0.2048>` stays one item. */
function fetchItems(line: string): string[] {
  const open = line.indexOf("(", line.toUpperCase().indexOf("FETCH"));
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = open; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "(" || ch === "[") {
      depth++;
      if (depth === 1 && ch === "(") continue;
    } else if (ch === ")" || ch === "]") {
      depth--;
      if (depth === 0 && ch === ")") break;
    }
    if (ch === " " && depth === 1) {
      if (current) items.push(current);
      current = "";
    } else current += ch;
  }
  if (current) items.push(current);
  return items;
}

export interface MiniImap {
  port: number;
  commands: string[];
  /** The data items of every FETCH, as the client wrote them. */
  fetches: string[][];
  /** Hang up on every connected client, as a server timing out idle sessions does. */
  dropAll(): void;
  close(): Promise<void>;
}

export async function startMiniImap(data: FakeServer, creds = { user: "me@example.com", pass: "pw" }): Promise<MiniImap> {
  const commands: string[] = [];
  const fetches: string[][] = [];
  const sockets = new Set<net.Socket>();
  const gmail = data.capabilities.has("X-GM-EXT-1");

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buf = Buffer.alloc(0);
    let commandText = "";
    let selected: FakeBox | undefined;
    let authed = false;
    // A command whose line ended in a literal marker waits here for the literal's bytes.
    let pending: { text: string; literals: Buffer[]; need: number } | undefined;

    const caps = () => ["IMAP4rev1", "ENABLE", "UIDPLUS", "MOVE", "SPECIAL-USE", ...data.capabilities].filter((c, i, a) => a.indexOf(c) === i).join(" ");
    const write = (s: string | Buffer): void => void socket.write(s);
    const send = (s: string): void => write(`${s}\r\n`);

    send(`* OK [CAPABILITY ${caps()}] mini imap ready`);

    const messagesOf = () => selected!.messages;
    const flagList = (m: FakeMessage) => [...m.flags].join(" ");

    function parseSearch(tokens: Token[], max: number): (m: FakeMessage) => boolean {
      let i = 0;
      const key = (): ((m: FakeMessage) => boolean) => {
        const t = tokens[i++];
        if (Array.isArray(t)) {
          const inner = parseSearch(t, max);
          return inner;
        }
        switch (String(t).toUpperCase()) {
          case "ALL":
            return () => true;
          case "UID": {
            const inSet = uidSet(String(tokens[i++]), max);
            return (m) => inSet(m.uid);
          }
          case "SINCE": {
            const [d, mon, y] = String(tokens[i++]).split("-");
            const from = Date.UTC(Number(y), MONTHS.indexOf(mon!), Number(d));
            return (m) => m.internalDate.getTime() >= from;
          }
          case "HEADER": {
            const name = String(tokens[i++]);
            const value = String(tokens[i++]);
            return (m) => {
              const line = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(m.source.toString("latin1"))?.[1] ?? "";
              return value === "" ? Boolean(line) : line.toLowerCase().includes(value.toLowerCase());
            };
          }
          case "X-GM-RAW": {
            const query = String(tokens[i++]);
            return (m) => (query === "in:inbox" ? Boolean(m.labels?.has("\\Inbox")) : true);
          }
          case "OR": {
            const a = key();
            const b = key();
            return (m) => a(m) || b(m);
          }
          case "NOT": {
            const a = key();
            return (m) => !a(m);
          }
          default:
            throw new Error(`unsupported search key ${String(t)}`);
        }
      };
      const keys: ((m: FakeMessage) => boolean)[] = [];
      while (i < tokens.length) keys.push(key());
      return (m) => keys.every((k) => k(m));
    }

    function fetchLine(m: FakeMessage, seq: number, items: string[], forceUid: boolean): Buffer {
      const parts: (string | { name: string; data: Buffer })[] = [];
      const wanted = new Set(items.map((x) => x.toUpperCase()));
      if (forceUid || wanted.has("UID")) parts.push(`UID ${m.uid}`);
      if (wanted.has("FLAGS")) parts.push(`FLAGS (${flagList(m)})`);
      if (wanted.has("INTERNALDATE")) parts.push(`INTERNALDATE "${imapDate(m.internalDate)}"`);
      if (wanted.has("RFC822.SIZE")) parts.push(`RFC822.SIZE ${m.source.length}`);
      if (wanted.has("BODYSTRUCTURE")) parts.push(`BODYSTRUCTURE ${structureWire(structureOf(m.source))}`);
      if (wanted.has("X-GM-LABELS")) parts.push(`X-GM-LABELS (${[...(m.labels ?? [])].map((l) => (l.startsWith("\\") ? l : `"${l}"`)).join(" ")})`);
      if (wanted.has("X-GM-THRID")) parts.push(`X-GM-THRID ${m.threadId ?? "0"}`);
      if (wanted.has("X-GM-MSGID")) parts.push(`X-GM-MSGID ${1000 + m.uid}`);
      if (wanted.has("MODSEQ") && data.condstore) parts.push(`MODSEQ (${m.modseq})`);
      for (const item of items) {
        const body = /^BODY(?:\.PEEK)?\[(.*?)\](?:<(\d+)(?:\.(\d+))?>)?$/i.exec(item);
        if (!body) continue;
        const section = body[1]!;
        const field = /^HEADER\.FIELDS\s*\((.*)\)$/i.exec(section);
        let bytes: Buffer | undefined;
        if (section === "") bytes = m.source;
        else if (field) bytes = headerBlock(m.source, field[1]!.split(/\s+/).filter(Boolean));
        else bytes = partBytes(m.source, section);
        if (!bytes) continue;
        const start = body[2] ? Number(body[2]) : 0;
        const slice = body[3] ? bytes.subarray(start, start + Number(body[3])) : bytes.subarray(start);
        parts.push({ name: `BODY[${section}]${body[2] ? `<${start}>` : ""}`, data: slice });
      }
      const out: Buffer[] = [Buffer.from(`* ${seq} FETCH (`, "latin1")];
      parts.forEach((p, i) => {
        if (i > 0) out.push(Buffer.from(" "));
        if (typeof p === "string") out.push(Buffer.from(p, "latin1"));
        else out.push(Buffer.from(`${p.name} {${p.data.length}}\r\n`, "latin1"), p.data);
      });
      out.push(Buffer.from(")\r\n"));
      return Buffer.concat(out);
    }

    function handle(tag: string, command: string, args: Token[], literals: Buffer[]): void {
      const cmd = command.toUpperCase();
      commands.push(`${cmd} ${args.map((a) => (Array.isArray(a) ? "(...)" : a)).slice(0, 3).join(" ")}`.trim());
      const ok = (text = "Completed") => send(`${tag} OK ${text}`);
      try {
        switch (cmd) {
          case "CAPABILITY":
            send(`* CAPABILITY ${caps()}`);
            return ok();
          case "NOOP":
            return ok();
          case "LOGIN":
            if (args[0] === creds.user && args[1] === creds.pass) {
              authed = true;
              return ok(`[CAPABILITY ${caps()}] Logged in`);
            }
            return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
          case "ENABLE":
            send(`* ENABLED${data.condstore ? " CONDSTORE" : ""}`);
            return ok();
          case "LOGOUT":
            send("* BYE bye");
            ok();
            return void socket.end();
        }
        if (!authed) return send(`${tag} BAD not authenticated`);

        switch (cmd) {
          case "LIST":
          case "LSUB": {
            const pattern = String(args[1] ?? "*");
            if (pattern === "") {
              send(`* ${cmd} (\\Noselect) "/" ""`);
            } else {
              for (const b of data.boxes.values()) {
                const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/%/g, "[^/]*")}$`);
                if (!re.test(b.path)) continue;
                send(`* ${cmd} (\\HasNoChildren${b.specialUse ? ` ${b.specialUse}` : ""}) "/" "${b.path}"`);
              }
            }
            return ok();
          }
          case "CREATE": {
            const path = String(args[0]);
            if (data.boxes.has(path)) return send(`${tag} NO [ALREADYEXISTS] exists`);
            data.add(path);
            return ok();
          }
          case "SUBSCRIBE":
            return ok();
          case "SELECT":
          case "EXAMINE": {
            const box = data.boxes.get(String(args[0]));
            if (!box) return send(`${tag} NO [NONEXISTENT] no such mailbox`);
            selected = box;
            send("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)");
            send(`* ${box.messages.length} EXISTS`);
            send("* 0 RECENT");
            send(`* OK [UIDVALIDITY ${box.uidValidity}] ok`);
            send(`* OK [UIDNEXT ${box.uidNext}] ok`);
            send(`* OK [PERMANENTFLAGS (${[...(box.permanentFlags ?? [])].join(" ")})] ok`);
            if (data.condstore) send(`* OK [HIGHESTMODSEQ ${box.highestModseq}] ok`);
            return ok(`[${cmd === "SELECT" ? "READ-WRITE" : "READ-ONLY"}] done`);
          }
          case "CLOSE":
          case "UNSELECT":
            selected = undefined;
            return ok();
          case "APPEND": {
            const path = String(args[0]);
            const box = data.boxes.get(path);
            if (!box) return send(`${tag} NO [TRYCREATE] no such mailbox`);
            const flagsArg = Array.isArray(args[1]) ? (args[1] as string[]) : [];
            const lit = literals[literals.length - 1]!;
            if (data.failAppend) return send(`${tag} NO [OVERQUOTA] Over quota`);
            data.appended.push({ path, raw: lit, flags: flagsArg });
            const uid = data.deliver(path, lit, { flags: flagsArg });
            return ok(`[APPENDUID ${box.uidValidity} ${uid}] Appended`);
          }
        }

        if (!selected) return send(`${tag} NO no mailbox selected`);
        const useUid = cmd === "UID";
        const sub = useUid ? String(args[0]).toUpperCase() : cmd;
        const rest = useUid ? args.slice(1) : args;
        const max = (name: "uid" | "seq") => (name === "uid" ? (messagesOf().at(-1)?.uid ?? 0) : messagesOf().length);

        switch (sub) {
          case "SEARCH": {
            const test = parseSearch(rest, max("uid"));
            const hits = messagesOf().map((m, i) => [m, i + 1] as const).filter(([m]) => test(m));
            send(`* SEARCH${hits.map(([m, i]) => ` ${useUid ? m.uid : i}`).join("")}`);
            return ok();
          }
          case "FETCH": {
            const set = String(rest[0]);
            const items = fetchItems(commandText);
            fetches.push(items);
            const mods = rest[2] as string[] | undefined;
            const since = mods?.[0]?.toUpperCase() === "CHANGEDSINCE" ? BigInt(mods[1]!) : undefined;
            const inSet = uidSet(set, max(useUid ? "uid" : "seq"));
            messagesOf().forEach((m, i) => {
              if (!inSet(useUid ? m.uid : i + 1)) return;
              if (since !== undefined && m.modseq <= since) return;
              write(fetchLine(m, i + 1, items, useUid));
            });
            return ok();
          }
          case "STORE": {
            const inSet = uidSet(String(rest[0]), max("uid"));
            const op = String(rest[1]).toUpperCase();
            const values = (rest[2] as string[]).map(String);
            const labels = op.includes("X-GM-LABELS");
            const add = op.startsWith("+");
            const remove = op.startsWith("-");
            messagesOf().forEach((m, i) => {
              if (!inSet(m.uid)) return;
              const set = labels ? (m.labels ??= new Set()) : m.flags;
              if (!add && !remove) set.clear();
              for (const v of values) (remove ? set.delete(v) : set.add(v));
              m.modseq = ++selected!.highestModseq;
              if (!op.includes("SILENT")) write(fetchLine(m, i + 1, labels ? ["UID", "X-GM-LABELS"] : ["UID", "FLAGS"], true));
            });
            return ok();
          }
          case "MOVE": {
            const inSet = uidSet(String(rest[0]), max("uid"));
            const dest = data.boxes.get(String(rest[1]));
            if (!dest) return send(`${tag} NO [TRYCREATE] no such mailbox`);
            const moved = messagesOf().filter((m) => inSet(m.uid));
            const newUids: number[] = [];
            for (const m of moved) {
              newUids.push(data.deliver(dest.path, m.source, { flags: [...m.flags], labels: m.labels && [...m.labels], threadId: m.threadId, date: m.internalDate }));
            }
            const seqs = moved.map((m) => messagesOf().indexOf(m) + 1);
            for (const m of moved) data.expunge(selected.path, m.uid);
            send(`* OK [COPYUID ${dest.uidValidity} ${moved.map((m) => m.uid).join(",")} ${newUids.join(",")}] moved`);
            for (const seq of seqs.reverse()) send(`* ${seq} EXPUNGE`);
            return ok();
          }
        }
        send(`${tag} BAD unsupported command ${cmd} ${sub}`);
      } catch (err) {
        send(`${tag} BAD ${(err as Error).message}`);
      }
    }

    function drain() {
      for (;;) {
        if (pending && pending.need > 0) {
          if (buf.length < pending.need) return;
          pending.literals.push(buf.subarray(0, pending.need));
          buf = buf.subarray(pending.need);
          pending.need = 0;
        }
        const eol = buf.indexOf("\r\n");
        if (eol < 0) return;
        const line = buf.subarray(0, eol).toString("latin1");
        buf = buf.subarray(eol + 2);
        const state = pending ?? { text: "", literals: [], need: 0 };
        pending = undefined;
        const lit = /\{(\d+)(\+?)\}$/.exec(line);
        if (lit) {
          state.text += line.slice(0, lit.index) + `"\0L${state.literals.length}"`;
          state.need = Number(lit[1]);
          if (!lit[2]) send("+ ready");
          pending = state;
          continue;
        }
        const full = state.text + line;
        commandText = full;
        const [tag, command, ...rest] = tokenize(full) as string[] & Token[];
        handle(String(tag), String(command), rest as Token[], state.literals);
      }
    }

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk as Buffer]);
      drain();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    commands,
    fetches,
    dropAll: () => {
      for (const s of sockets) s.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
