/**
 * An in-memory IMAP server and the slice of ImapFlow's API that ImapProvider uses, so the provider can be
 * exercised without a network. The server keeps real IMAP bookkeeping (UIDs, UIDVALIDITY, MODSEQ, flags, labels);
 * a connection refuses commands that need a selected mailbox unless a lock is held, as imapflow would.
 */
import type { FetchMessageObject, FetchQueryObject, ListResponse, MailboxObject, SearchObject } from "imapflow";
import type { ImapClient } from "../src/providers/imap.ts";
import { headerBlock, partBytes, structureOf } from "./mime-fake.ts";

export interface FakeMessage {
  uid: number;
  flags: Set<string>;
  labels?: Set<string>;
  threadId?: string;
  /** Gmail's tab for the message (personal, promotions, social, updates, forums): what `X-GM-RAW category:<tab>` finds. */
  gmCategory?: string;
  internalDate: Date;
  source: Buffer;
  modseq: bigint;
}

export interface FakeBox {
  path: string;
  specialUse?: string;
  uidValidity: bigint;
  uidNext: number;
  highestModseq: bigint;
  permanentFlags?: Set<string>;
  messages: FakeMessage[];
}

export interface FakeOptions {
  capabilities?: string[];
  /** Report HIGHESTMODSEQ and honour CHANGEDSINCE. */
  condstore?: boolean;
}

export class FakeServer {
  boxes = new Map<string, FakeBox>();
  capabilities: Set<string>;
  condstore: boolean;
  connections: FakeConn[] = [];
  appended: { path: string; raw: Buffer; flags: string[] }[] = [];
  failAppend = false;
  /** Make every X-GM-RAW search fail: "refuse" answers BAD as a server that doesn't know the syntax would; "drop" fails as a timeout or a reset would. */
  failGmraw: "refuse" | "drop" | null = null;
  log: string[] = [];
  /** Whole messages handed out (a FETCH asking for the source): a first sync should never need one. */
  fullFetches = 0;
  /** Partial text fetches (BODY[part]<0.n>), as the provider asked for them. */
  partFetches: { key: string; maxLength: number | undefined }[] = [];
  /** The part keys of each FETCH command that asked for text parts, in order: one entry per round trip. */
  partCommands: string[][] = [];
  /** How many messages each FETCH of whole sources asked for, in order: one entry per round trip. */
  sourceCommands: number[] = [];

  constructor(opts: FakeOptions = {}) {
    this.capabilities = new Set(opts.capabilities ?? ["IMAP4rev1", "UIDPLUS", "MOVE", "ESEARCH"]);
    this.condstore = opts.condstore ?? false;
    if (this.condstore) this.capabilities.add("CONDSTORE");
  }

  add(path: string, specialUse?: string): FakeBox {
    const box: FakeBox = {
      path,
      specialUse,
      uidValidity: 1n,
      uidNext: 1,
      highestModseq: 1n,
      permanentFlags: new Set(["\\Seen", "\\Flagged", "\\Deleted", "\\Draft", "\\*"]),
      messages: [],
    };
    this.boxes.set(path, box);
    return box;
  }

  /** Deliver a message into a mailbox; returns its UID. */
  deliver(path: string, source: string | Buffer, extra: { flags?: string[]; labels?: string[]; threadId?: string; date?: Date; category?: string } = {}): number {
    const box = this.boxes.get(path)!;
    const msg: FakeMessage = {
      uid: box.uidNext++,
      flags: new Set(extra.flags ?? []),
      labels: extra.labels ? new Set(extra.labels) : undefined,
      threadId: extra.threadId,
      gmCategory: extra.category,
      internalDate: extra.date ?? new Date(),
      source: Buffer.isBuffer(source) ? source : Buffer.from(source),
      modseq: ++box.highestModseq,
    };
    box.messages.push(msg);
    return msg.uid;
  }

  find(path: string, uid: number): FakeMessage | undefined {
    return this.boxes.get(path)?.messages.find((m) => m.uid === uid);
  }

  /** Change a message the way another client would, bumping MODSEQ so CHANGEDSINCE sees it. */
  change(path: string, uid: number, fn: (m: FakeMessage) => void): void {
    const m = this.find(path, uid)!;
    fn(m);
    m.modseq = ++this.boxes.get(path)!.highestModseq;
  }

  expunge(path: string, uid: number): void {
    const box = this.boxes.get(path)!;
    box.messages = box.messages.filter((m) => m.uid !== uid);
    box.highestModseq++;
  }

  /** All messages in a mailbox as Message-ID headers, in UID order. */
  ids(path: string): string[] {
    return this.boxes.get(path)!.messages.map((m) => /^Message-ID:\s*(.*)$/im.exec(m.source.toString("latin1"))?.[1]?.trim() ?? "");
  }

  connect(): FakeConn {
    const c = new FakeConn(this);
    this.connections.push(c);
    return c;
  }
}

function parseRange(range: string, max: number): [number, number][] {
  return range.split(",").map((part) => {
    const [a, b] = part.split(":");
    const lo = a === "*" ? max : Number(a);
    const hi = b === undefined ? lo : b === "*" ? max : Number(b);
    return [Math.min(lo, hi), Math.max(lo, hi)] as [number, number];
  });
}

export class FakeConn {
  server: FakeServer;
  usable = true;
  mailbox: MailboxObject | false = false;
  capabilities: Map<string, boolean | number>;
  openLocks = 0;
  loggedOut = false;
  private box?: FakeBox;
  private listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  connectError?: unknown;

  constructor(server: FakeServer) {
    this.server = server;
    this.capabilities = new Map([...server.capabilities].map((c) => [c, true]));
  }

  asClient(): ImapClient {
    return this as unknown as ImapClient;
  }

  on(event: string, fn: (...a: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
    return this;
  }

  /** Simulate the server dropping the socket. */
  drop() {
    this.usable = false;
    for (const fn of this.listeners.get("close") ?? []) fn();
  }

  async connect() {
    if (this.connectError) throw this.connectError;
  }

  async logout() {
    this.loggedOut = true;
    this.usable = false;
  }

  close() {
    this.usable = false;
  }

  private ensureUsable() {
    if (!this.usable) throw Object.assign(new Error("Connection not available"), { code: "NoConnection" });
  }

  async list(): Promise<ListResponse[]> {
    this.ensureUsable();
    this.server.log.push("list");
    return [...this.server.boxes.values()].map((b) => {
      const parts = b.path.split("/");
      return {
        path: b.path,
        pathAsListed: b.path,
        name: parts[parts.length - 1]!,
        delimiter: "/",
        parent: parts.slice(0, -1),
        parentPath: parts.slice(0, -1).join("/"),
        flags: new Set<string>(b.specialUse ? [b.specialUse] : []),
        specialUse: b.specialUse,
        listed: true,
        subscribed: true,
      };
    });
  }

  async getMailboxLock(path: string, _opts?: { readOnly?: boolean }) {
    this.ensureUsable();
    const box = this.server.boxes.get(path);
    if (!box) throw Object.assign(new Error("Command failed"), { responseStatus: "NO", responseText: "Mailbox doesn't exist", mailboxMissing: true });
    this.box = box;
    this.mailbox = {
      path,
      delimiter: "/",
      flags: new Set(),
      permanentFlags: box.permanentFlags,
      uidValidity: box.uidValidity,
      uidNext: box.uidNext,
      exists: box.messages.length,
      highestModseq: this.server.condstore ? box.highestModseq : undefined,
    };
    this.openLocks++;
    let released = false;
    return {
      path,
      release: () => {
        if (!released) this.openLocks--;
        released = true;
      },
    };
  }

  private selected(): FakeBox {
    this.ensureUsable();
    if (!this.box || this.openLocks === 0) throw new Error("command issued without a mailbox lock");
    return this.box;
  }

  private toFetch(m: FakeMessage, seq: number, q: FetchQueryObject): FetchMessageObject {
    const out: FetchMessageObject = { seq, uid: m.uid };
    if (q.flags) out.flags = new Set(m.flags);
    if (q.labels && this.capabilities.has("X-GM-EXT-1")) out.labels = new Set(m.labels ?? []);
    if (q.threadId && m.threadId) out.threadId = m.threadId;
    if (q.internalDate) out.internalDate = m.internalDate;
    if (q.source) {
      out.source = m.source;
      this.server.fullFetches++;
    }
    if (q.size) out.size = m.source.length;
    if (q.bodyStructure) out.bodyStructure = structureOf(m.source);
    if (Array.isArray(q.headers)) out.headers = headerBlock(m.source, q.headers);
    if (q.bodyParts?.length) {
      out.bodyParts = new Map();
      for (const part of q.bodyParts) {
        const key = typeof part === "string" ? part : part.key;
        this.server.partFetches.push({ key, maxLength: typeof part === "string" ? undefined : part.maxLength });
        const bytes = partBytes(m.source, key);
        if (bytes) out.bodyParts.set(key.toLowerCase(), typeof part === "string" || !part.maxLength ? bytes : bytes.subarray(0, part.maxLength));
      }
    }
    if (this.server.condstore) out.modseq = m.modseq;
    return out;
  }

  async fetchAll(range: string | number[], query: FetchQueryObject, opts: { uid?: boolean; changedSince?: bigint | number } = {}) {
    const box = this.selected();
    const msgs = box.messages;
    const maxUid = msgs.at(-1)?.uid ?? 0;
    let picked: [FakeMessage, number][];
    if (Array.isArray(range)) {
      const set = new Set(range);
      picked = msgs.map((m, i) => [m, i + 1] as [FakeMessage, number]).filter(([m]) => set.has(m.uid));
    } else if (opts.uid) {
      const ranges = parseRange(range, maxUid);
      picked = msgs.map((m, i) => [m, i + 1] as [FakeMessage, number]).filter(([m]) => ranges.some(([a, b]) => m.uid >= a && m.uid <= b));
    } else {
      const ranges = parseRange(range, msgs.length);
      picked = msgs.map((m, i) => [m, i + 1] as [FakeMessage, number]).filter(([, seq]) => ranges.some(([a, b]) => seq >= a && seq <= b));
    }
    if (opts.changedSince !== undefined) {
      if (!this.server.condstore) throw new Error("CHANGEDSINCE without CONDSTORE");
      picked = picked.filter(([m]) => m.modseq > BigInt(opts.changedSince!));
    }
    if (query.source) this.server.sourceCommands.push(picked.length);
    if (query.bodyParts?.length) this.server.partCommands.push(query.bodyParts.map((p) => (typeof p === "string" ? p : p.key)));
    this.server.log.push(`fetch ${box.path} ${Array.isArray(range) ? range.length + " uids" : range}${opts.changedSince !== undefined ? " changedSince" : ""}`);
    return picked.map(([m, seq]) => this.toFetch(m, seq, query));
  }

  async fetchOne(seq: string, query: FetchQueryObject, opts: { uid?: boolean } = {}) {
    const box = this.selected();
    const i = box.messages.findIndex((m) => (opts.uid ? m.uid === Number(seq) : false));
    return i < 0 ? false : this.toFetch(box.messages[i]!, i + 1, query);
  }

  private matches(m: FakeMessage, q: SearchObject, maxUid: number): boolean {
    if (q.uid !== undefined) {
      const ranges = parseRange(String(q.uid), maxUid);
      // RFC 3501: "N:*" is the range between N and the highest UID in either order, so it can include a lower UID.
      if (!ranges.some(([a, b]) => m.uid >= a && m.uid <= b)) return false;
    }
    if (q.since && m.internalDate.getTime() < new Date(q.since).getTime()) return false;
    const text = m.source.toString("latin1").toLowerCase();
    const header = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, "im").exec(m.source.toString("latin1"))?.[1]?.toLowerCase() ?? "";
    if (q.gmraw !== undefined) {
      // Gmail's own language is stood in for by its simplest part: every plain word must appear in the message.
      const tab = /^category:(\w+)$/.exec(q.gmraw)?.[1];
      if (tab !== undefined) {
        if (m.gmCategory !== tab) return false;
      } else if (q.gmraw === "in:inbox") {
        if (!m.labels?.has("\\Inbox")) return false;
      } else if (!q.gmraw.split(/\s+/).filter((w) => w && !w.includes(":") && !w.startsWith("-")).every((w) => text.includes(w.replace(/"/g, "").toLowerCase()))) return false;
    }
    if (q.from !== undefined && !header("from").includes(q.from.toLowerCase())) return false;
    if (q.to !== undefined && !header("to").includes(q.to.toLowerCase())) return false;
    if (q.subject !== undefined && !header("subject").includes(q.subject.toLowerCase())) return false;
    if (q.text !== undefined && !text.includes(q.text.toLowerCase())) return false;
    if (q.body !== undefined && !text.includes(q.body.toLowerCase())) return false;
    // BEFORE is exclusive and works on the day, as on a real server.
    if (q.before && m.internalDate.getTime() >= new Date(q.before).getTime()) return false;
    if (q.not && this.matches(m, q.not, maxUid)) return false;
    if (q.header) {
      for (const [name, value] of Object.entries(q.header)) {
        const line = new RegExp(`^${name}:\\s*(.*)$`, "im").exec(m.source.toString("latin1"))?.[1] ?? "";
        if (typeof value === "string" ? !line.includes(value) : !line) return false;
      }
    }
    if (q.or && !q.or.some((sub) => this.matches(m, sub, maxUid))) return false;
    return true;
  }

  async search(query: SearchObject, _opts?: { uid?: boolean }) {
    const box = this.selected();
    const maxUid = box.messages.at(-1)?.uid ?? 0;
    this.server.log.push(`search ${box.path} ${JSON.stringify(query)}`);
    if (query.gmraw !== undefined && this.server.failGmraw === "refuse") throw Object.assign(new Error("Command failed"), { responseStatus: "BAD", responseText: "Could not parse command" });
    if (query.gmraw !== undefined && this.server.failGmraw === "drop") throw Object.assign(new Error("Socket timeout"), { code: "ETIMEDOUT" });
    return box.messages.filter((m) => this.matches(m, query, maxUid)).map((m) => m.uid);
  }

  private targets(box: FakeBox, uids: number[] | string): FakeMessage[] {
    const set = new Set(typeof uids === "string" ? [] : uids);
    return box.messages.filter((m) => set.has(m.uid));
  }

  async messageFlagsAdd(uids: number[], flags: string[], opts: { uid?: boolean; useLabels?: boolean } = {}) {
    return this.store(uids, flags, opts, true);
  }

  async messageFlagsRemove(uids: number[], flags: string[], opts: { uid?: boolean; useLabels?: boolean } = {}) {
    return this.store(uids, flags, opts, false);
  }

  private store(uids: number[], flags: string[], opts: { uid?: boolean; useLabels?: boolean }, add: boolean) {
    const box = this.selected();
    if (!opts.uid) throw new Error("expected UID mode");
    for (const m of this.targets(box, uids)) {
      const set = opts.useLabels ? (m.labels ??= new Set()) : m.flags;
      for (const f of flags) add ? set.add(f) : set.delete(f);
      m.modseq = ++box.highestModseq;
    }
    this.server.log.push(`store ${box.path} ${add ? "+" : "-"}${opts.useLabels ? "labels" : "flags"} ${flags.join(" ")} uids=${uids.join(",")}`);
    return true;
  }

  async messageMove(uids: number[], destination: string, opts: { uid?: boolean } = {}) {
    const box = this.selected();
    const dest = this.server.boxes.get(destination);
    if (!dest) throw Object.assign(new Error("Command failed"), { responseStatus: "NO", responseText: "Mailbox doesn't exist" });
    if (!opts.uid) throw new Error("expected UID mode");
    const uidMap = new Map<number, number>();
    for (const m of this.targets(box, uids)) {
      uidMap.set(m.uid, this.server.deliver(destination, m.source, { flags: [...m.flags], labels: m.labels && [...m.labels], threadId: m.threadId, date: m.internalDate, category: m.gmCategory }));
      this.server.expunge(box.path, m.uid);
    }
    this.server.log.push(`move ${box.path} -> ${destination} uids=${uids.join(",")}`);
    return { path: box.path, destination, uidMap };
  }

  async mailboxCreate(path: string) {
    this.ensureUsable();
    if (this.server.boxes.has(path)) return { path, created: false };
    this.server.add(path);
    this.server.log.push(`create ${path}`);
    return { path, created: true };
  }

  async append(path: string, content: Buffer, flags: string[] = []) {
    this.ensureUsable();
    if (this.server.failAppend) throw Object.assign(new Error("Command failed"), { responseStatus: "NO", responseText: "Over quota" });
    this.server.appended.push({ path, raw: content, flags });
    this.server.deliver(path, content, { flags });
    return { destination: path };
  }
}
