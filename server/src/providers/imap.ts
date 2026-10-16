import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type ListResponse, type MailboxObject, type SearchObject } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import { extractAttachment, parseRaw } from "../mail/mime.ts";
import {
  PermanentProviderError,
  ProviderAuthError,
  type FlagUpdate,
  type Folders,
  type IncomingMessage,
  type MailProvider,
  type OutgoingMessage,
  type ProviderContext,
  type RemoteAction,
  type SyncPage,
  type ThreadRef,
} from "../mail/types.ts";

export interface ImapSettings {
  username: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

export const IMAP_PRESETS: Record<string, Omit<ImapSettings, "username" | "password"> & { label: string; help: string }> = {
  gmail: {
    label: "Gmail",
    help: "Create an app password at myaccount.google.com/apppasswords (it needs 2-Step Verification) and use it instead of your Google password.",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
    smtpSecure: true,
  },
  icloud: {
    label: "iCloud Mail",
    help: "Create an app-specific password at account.apple.com (Sign-In and Security) and use it instead of your Apple ID password.",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecure: false,
  },
  fastmail: {
    label: "Fastmail",
    help: "Create an app password in Fastmail under Settings, Privacy & Security, Integrations, with mail (IMAP/SMTP) access.",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    smtpSecure: true,
  },
  yahoo: {
    label: "Yahoo Mail",
    help: "Generate an app password in Yahoo Account Security and use it instead of your Yahoo password.",
    imapHost: "imap.mail.yahoo.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.mail.yahoo.com",
    smtpPort: 465,
    smtpSecure: true,
  },
  zoho: {
    label: "Zoho Mail",
    help: "Turn on IMAP in Zoho Mail settings. If you use two-factor authentication, create an application-specific password.",
    imapHost: "imap.zoho.com",
    imapPort: 993,
    imapSecure: true,
    smtpHost: "smtp.zoho.com",
    smtpPort: 465,
    smtpSecure: true,
  },
  proton: {
    label: "Proton Mail (Bridge)",
    help: "Run Proton Mail Bridge on this computer and sign in there. Use the username and the Bridge password it shows, not your Proton password.",
    imapHost: "127.0.0.1",
    imapPort: 1143,
    imapSecure: false,
    smtpHost: "127.0.0.1",
    smtpPort: 1025,
    smtpSecure: false,
  },
};

/* ---------------------------------------------------------------- errors and connections */

const isLoopback = (host: string) => host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

/** What imapflow and nodemailer errors carry that is worth showing a person. */
interface RawError {
  message?: string;
  code?: string;
  responseText?: string;
  response?: string;
  responseCode?: number;
  authenticationFailed?: boolean;
  tlsFailed?: boolean;
}

/** Turn a connection, login or protocol failure into a sentence a person can act on. */
export function friendlyError(err: unknown, protocol: "IMAP" | "SMTP", host: string): Error {
  if (err instanceof ProviderAuthError || err instanceof PermanentProviderError) return err;
  const e = (err ?? {}) as RawError;
  const detail = (e.responseText || e.response || e.message || String(err)).replace(/\s+/g, " ").trim();
  if (e.authenticationFailed || e.code === "EAUTH") {
    return new ProviderAuthError(
      `${host} rejected the ${protocol} sign-in (${detail}). Check the username and password; many providers need an app password instead of your normal one.`,
    );
  }
  if (e.tlsFailed) {
    return new Error(
      `${host} doesn't offer an encrypted (STARTTLS) connection on this port, and Slipstream won't send your password unencrypted. Use the server's TLS port, usually 993 for IMAP and 465 for SMTP.`,
    );
  }
  switch (e.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EDNS":
      return new Error(`Couldn't find the server ${host}. Check the ${protocol} server name.`);
    case "ECONNREFUSED":
      return new Error(`${host} refused the ${protocol} connection. Check the port, and that the server (or Proton Bridge) is running.`);
    case "ETIMEDOUT":
    case "ETIMEOUT":
    case "CONNECT_TIMEOUT":
    case "ESOCKETTIMEDOUT":
      return new Error(`${host} didn't answer in time over ${protocol}. Check the server name and port.`);
    case "ERR_SSL_WRONG_VERSION_NUMBER":
      return new Error(
        `${host} doesn't speak TLS on this ${protocol} port. Ports 993 and 465 use TLS from the start; ports 143 and 587 start plain and upgrade (turn the secure option off for those).`,
      );
    case "ECONNRESET":
    case "EPIPE":
      return new Error(`${host} closed the ${protocol} connection. Check the port and the TLS setting.`);
  }
  if (e.code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(e.code)) {
    return new Error(`Couldn't verify ${host}'s security certificate (${e.code}).`);
  }
  return new Error(`${protocol} ${host}: ${detail}`);
}

const fromWire = (err: unknown) =>
  typeof err === "object" && err !== null && ("code" in err || "responseText" in err || "responseStatus" in err || "authenticationFailed" in err || "tlsFailed" in err);

export type ImapClient = Pick<
  ImapFlow,
  | "connect"
  | "logout"
  | "close"
  | "on"
  | "list"
  | "getMailboxLock"
  | "fetchAll"
  | "fetchOne"
  | "search"
  | "messageFlagsAdd"
  | "messageFlagsRemove"
  | "messageMove"
  | "mailboxCreate"
  | "append"
  | "capabilities"
  | "usable"
  | "mailbox"
>;

export type SmtpTransport = Pick<Transporter, "sendMail" | "close">;

/** Test seams: swap the network clients for fakes. */
export interface ImapDeps {
  createClient?: (settings: ImapSettings) => ImapClient;
  createTransport?: (settings: ImapSettings) => SmtpTransport;
}

function createImapFlow(s: ImapSettings): ImapFlow {
  return new ImapFlow({
    host: s.imapHost,
    port: s.imapPort,
    secure: s.imapSecure,
    // Never send the password over a connection that could have its STARTTLS stripped.
    doSTARTTLS: s.imapSecure ? undefined : true,
    // Proton Bridge presents a self-signed certificate on loopback; nothing else gets that exemption.
    tls: isLoopback(s.imapHost) ? { rejectUnauthorized: false } : undefined,
    auth: { user: s.username, pass: s.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
  });
}

function createSmtp(s: ImapSettings) {
  return nodemailer.createTransport({
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpSecure,
    requireTLS: !s.smtpSecure,
    tls: isLoopback(s.smtpHost) ? { rejectUnauthorized: false } : undefined,
    auth: { user: s.username, pass: s.password },
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  });
}

export async function verifyImap(settings: ImapSettings): Promise<void> {
  const client = createImapFlow(settings);
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (err) {
    client.close();
    throw friendlyError(err, "IMAP", settings.imapHost);
  }
  await client.logout().catch(() => client.close());

  const smtp = createSmtp(settings);
  try {
    await smtp.verify();
  } catch (err) {
    throw friendlyError(err, "SMTP", settings.smtpHost);
  } finally {
    smtp.close();
  }
}

/* ---------------------------------------------------------------- mailbox roles */

export type MailboxRole = "inbox" | "sent" | "trash" | "junk" | "archive" | "all";
export type MailboxMap = Partial<Record<MailboxRole, string>>;
type ListedMailbox = Pick<ListResponse, "path" | "name" | "flags"> & { specialUse?: string | undefined };

const SPECIAL_USE: Record<string, MailboxRole> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\trash": "trash",
  "\\junk": "junk",
  "\\archive": "archive",
  "\\all": "all",
};

const ROLE_NAMES: Record<Exclude<MailboxRole, "inbox">, string[]> = {
  sent: ["sent", "sent items", "sent mail", "sent messages"],
  trash: ["trash", "deleted items", "deleted messages", "bin"],
  junk: ["junk", "spam", "junk e-mail", "junk email", "bulk mail"],
  archive: ["archive", "archives"],
  all: ["all mail"],
};

/** Find each role's mailbox: SPECIAL-USE flags first, then the usual names. */
export function detectMailboxes(list: ListedMailbox[]): MailboxMap {
  const map: MailboxMap = {};
  const usable = list.filter((m) => !m.flags?.has("\\Noselect") && !m.flags?.has("\\NonExistent"));
  for (const m of usable) {
    const flags = [m.specialUse, ...(m.flags ?? [])];
    for (const f of flags) {
      const role = f ? SPECIAL_USE[f.toLowerCase()] : undefined;
      if (role && !map[role]) map[role] = m.path;
    }
    if (!map.inbox && m.path.toUpperCase() === "INBOX") map.inbox = m.path;
  }
  // Shallowest path first, so "Archive" beats "Old/Archive".
  const byDepth = [...usable].sort((a, b) => a.path.length - b.path.length);
  for (const role of Object.keys(ROLE_NAMES) as (keyof typeof ROLE_NAMES)[]) {
    if (map[role]) continue;
    const hit = byDepth.find((m) => ROLE_NAMES[role].includes(m.name.toLowerCase()));
    if (hit) map[role] = hit.path;
  }
  return map;
}

interface SyncTarget {
  path: string;
  role: MailboxRole;
}

/** Gmail is read from All Mail (plus Trash and Spam, which All Mail excludes); everything else folder by folder. */
export function syncTargets(map: MailboxMap, gmail: boolean): SyncTarget[] {
  const order: MailboxRole[] = gmail ? ["all", "trash", "junk"] : ["inbox", "sent", "archive", "trash", "junk"];
  if (gmail && !map.all) {
    throw new Error(
      "Gmail's All Mail folder isn't visible over IMAP. In Gmail, open Settings, Forwarding and POP/IMAP, and make sure All Mail is shown in IMAP.",
    );
  }
  const targets: SyncTarget[] = [];
  for (const role of order) {
    const path = map[role] ?? (role === "inbox" ? "INBOX" : undefined);
    if (path) targets.push({ path, role });
  }
  return targets;
}

/* ---------------------------------------------------------------- cursor */

const WINDOW = 500;
const BATCH = 50;
const DAY_MS = 86_400_000;

interface BoxState {
  /** bigint, as a string: JSON can't carry bigints. */
  uidValidity: string;
  /** Everything up to here has been handed to the store. */
  lastUid: number;
  highestModseq?: string;
  /** UIDs of the newest messages as of the last change check, as "1:5,7"; the next check diffs against it to find expunges. */
  window?: string;
  /** Set while the first sync of this mailbox is still working through its backlog. */
  initial?: { since: number; ceiling: number | null };
}

interface Cursor {
  v: 1;
  /** Where in the current round we are: first one change check per mailbox, then one new-mail pass per mailbox. */
  step: number;
  boxes: Record<string, BoxState>;
}

export function parseCursor(raw: string | null): Cursor {
  const fresh: Cursor = { v: 1, step: 0, boxes: {} };
  if (!raw) return fresh;
  try {
    const o = JSON.parse(raw) as Partial<Cursor>;
    if (o.v !== 1 || typeof o.boxes !== "object" || o.boxes === null) return fresh;
    for (const [path, b] of Object.entries(o.boxes)) {
      if (typeof b?.uidValidity !== "string" || typeof b.lastUid !== "number") delete o.boxes[path];
    }
    return { v: 1, step: typeof o.step === "number" && o.step >= 0 ? o.step : 0, boxes: o.boxes };
  } catch {
    return fresh;
  }
}

export const serializeCursor = (c: Cursor) => JSON.stringify(c);

/** Record that a batch of new mail was handed over. `remaining` is how many UIDs are still queued behind it. */
export function finishBatch(st: BoxState, lastInBatch: number | undefined, remaining: number): void {
  if (remaining > 0) {
    st.lastUid = lastInBatch ?? st.lastUid;
    return;
  }
  // Nothing left: the first sync is complete up to the UIDNEXT it started from, later ones up to the newest UID seen.
  st.lastUid = Math.max(st.lastUid, lastInBatch ?? 0, st.initial?.ceiling ?? 0);
  delete st.initial;
}

/** "1:5,7,9:12" for a sorted list of UIDs. */
export function compressUids(uids: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < uids.length; ) {
    let j = i;
    while (j + 1 < uids.length && uids[j + 1] === uids[j]! + 1) j++;
    out.push(j > i ? `${uids[i]}:${uids[j]}` : String(uids[i]));
    i = j + 1;
  }
  return out.join(",");
}

export function expandUids(set: string | undefined): number[] {
  const out: number[] = [];
  for (const part of set ? set.split(",") : []) {
    const [a, b] = part.split(":").map(Number);
    if (a === undefined || Number.isNaN(a)) continue;
    for (let u = a; u <= (b ?? a); u++) out.push(u);
  }
  return out;
}

/**
 * Compare the newest messages now against the previous check. A UID we saw before that falls inside today's
 * window but is missing from it was expunged (or marked \Deleted). When the window is only the tail of a larger
 * mailbox, older UIDs merely left it, which proves nothing; when it is the whole mailbox, they're gone.
 */
export function findExpunged(previous: number[], current: { uid: number; deleted: boolean }[], wholeMailbox: boolean): number[] {
  const alive = new Set(current.filter((m) => !m.deleted).map((m) => m.uid));
  const low = wholeMailbox ? 0 : (current[0]?.uid ?? 0);
  return previous.filter((u) => u >= low && !alive.has(u));
}

/* ---------------------------------------------------------------- messages */

const remoteIdFor = (path: string, validity: string, uid: number) => `${path}:${validity}:${uid}`;

function parseRemoteId(id: string): { path: string; validity: string; uid: number } | null {
  const m = /^(.*):(\d+):(\d+)$/.exec(id);
  return m ? { path: m[1]!, validity: m[2]!, uid: Number(m[3]) } : null;
}

interface GmailLabels {
  inbox: boolean;
  sent: boolean;
  starred: boolean;
  draft: boolean;
  user: { remoteId: string; name: string }[];
}

/** Split X-GM-LABELS into the system labels we act on and the user's own labels. */
export function gmailLabels(labels: Iterable<string> | undefined): GmailLabels {
  const out: GmailLabels = { inbox: false, sent: false, starred: false, draft: false, user: [] };
  for (const l of labels ?? []) {
    if (l.startsWith("\\")) {
      const sys = l.slice(1).toLowerCase();
      if (sys === "inbox") out.inbox = true;
      else if (sys === "sent") out.sent = true;
      else if (sys === "starred") out.starred = true;
      else if (sys === "draft") out.draft = true;
    } else {
      out.user.push({ remoteId: l, name: l });
    }
  }
  return out;
}

const GENERIC_FOLDERS: Record<MailboxRole, Partial<Folders>> = {
  inbox: { inbox: true },
  sent: { sent: true },
  trash: { trash: true },
  junk: { spam: true },
  archive: {},
  all: {},
};

function foldersFor(role: MailboxRole, gmail: GmailLabels | null): Partial<Folders> {
  if (!gmail) return GENERIC_FOLDERS[role];
  if (role === "trash") return { trash: true };
  if (role === "junk") return { spam: true };
  return { inbox: gmail.inbox, sent: gmail.sent };
}

/** The part of a fetched message that lives on the server: flags, folders, labels. */
function stateOf(fm: FetchMessageObject, target: SyncTarget, gmail: boolean) {
  const flags = fm.flags ?? new Set<string>();
  const g = gmail ? gmailLabels(fm.labels) : null;
  return {
    skip: flags.has("\\Draft") || flags.has("\\Deleted") || Boolean(g?.draft),
    unread: !flags.has("\\Seen"),
    starred: flags.has("\\Flagged") || Boolean(g?.starred),
    folders: foldersFor(target.role, g),
    labels: g?.user,
  };
}

async function toIncoming(
  fm: FetchMessageObject,
  target: SyncTarget,
  validity: string,
  gmail: boolean,
  selfEmail: string,
): Promise<IncomingMessage | null> {
  const s = stateOf(fm, target, gmail);
  if (s.skip || !fm.source) return null;
  const { message } = await parseRaw(fm.source, {
    remoteId: remoteIdFor(target.path, validity, fm.uid),
    remoteThreadId: gmail ? fm.threadId : undefined,
    folders: s.folders,
    unread: s.unread,
    starred: s.starred,
    labels: s.labels,
    selfEmail,
    receivedAt: fm.internalDate ? new Date(fm.internalDate).getTime() : undefined,
  });
  // Ours means "in the Sent folder" (aliases included), never "the From header says so": anyone can write a From.
  message.outgoing = Boolean(s.folders.sent);
  return message;
}

function flagUpdateOf(fm: FetchMessageObject, target: SyncTarget, validity: string, gmail: boolean): FlagUpdate {
  const s = stateOf(fm, target, gmail);
  const update: FlagUpdate = { remoteId: remoteIdFor(target.path, validity, fm.uid), unread: s.unread, starred: s.starred };
  // Folder membership only moves around in Gmail (labels); elsewhere a message's mailbox never changes under its UID.
  if (gmail) {
    update.folders = s.folders;
    update.labels = s.labels;
  }
  return update;
}

const flagSignature = (u: FlagUpdate) =>
  JSON.stringify([u.unread, u.starred, u.folders, u.labels?.map((l) => l.name).sort()]);

/* ---------------------------------------------------------------- sending */

/**
 * Remove the Bcc header from raw message bytes (including folded continuation lines) without touching anything
 * else: headers are read as latin1 so every byte round-trips, and the body is never decoded.
 */
export function stripBccHeader(raw: Buffer): Buffer {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  let headEnd: number; // length of the header block including its last line break
  if (crlf >= 0 && (lf < 0 || crlf < lf)) headEnd = crlf + 2;
  else if (lf >= 0) headEnd = lf + 1;
  else headEnd = raw.length;
  const head = raw.toString("latin1", 0, headEnd);
  const stripped = head.replace(/^bcc[ \t]*:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*(?:\r?\n|$)/gim, "");
  if (stripped === head) return raw;
  return Buffer.concat([Buffer.from(stripped, "latin1"), raw.subarray(headEnd)]);
}

/** Hosts whose SMTP server files the sent message itself; appending our own copy would duplicate it. */
const SAVES_SENT_MAIL = /(^|\.)(gmail\.com|googlemail\.com|outlook\.com|office365\.com|hotmail\.com|live\.com|icloud\.com|me\.com)$/i;
export const savesSentMail = (imapHost: string) => SAVES_SENT_MAIL.test(imapHost);

/** IMAP keywords are atoms: no spaces, quotes, brackets or non-ASCII. */
export function keywordFor(label: string): string | null {
  const kw = label.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return kw ? kw : null;
}

/* ---------------------------------------------------------------- provider */

interface StepResult {
  messages: IncomingMessage[];
  flagUpdates: FlagUpdate[];
  deleted: string[];
  /** More new mail is queued behind this batch. */
  more: boolean;
}

const emptyStep = (): StepResult => ({ messages: [], flagUpdates: [], deleted: [], more: false });

interface Layout {
  gmail: boolean;
  map: MailboxMap;
  targets: SyncTarget[];
}

async function withMailbox<T>(c: ImapClient, path: string, readOnly: boolean, fn: (mb: MailboxObject) => Promise<T>): Promise<T> {
  const lock = await c.getMailboxLock(path, { readOnly });
  try {
    return await fn(c.mailbox as MailboxObject);
  } finally {
    lock.release();
  }
}

export class ImapProvider implements MailProvider {
  readonly kind = "imap" as const;

  private ctx: ProviderContext;
  private settings: ImapSettings;
  private deps: ImapDeps;
  private client?: ImapClient;
  private connecting?: Promise<ImapClient>;
  private smtp?: SmtpTransport;
  /** UIDs still to fetch, per mailbox: spares re-running a large SEARCH for every batch of the first sync. */
  private queued = new Map<string, number[]>();
  /** Last flags sent per mailbox window, so an unchanged message isn't re-announced every round. */
  private signatures = new Map<string, Map<number, string>>();
  /** Gmail: remote ids of messages we moved out of a mailbox, to retire even if they're outside the change window. */
  private moved = new Set<string>();

  constructor(ctx: ProviderContext, deps: ImapDeps = {}) {
    this.ctx = ctx;
    this.settings = ctx.auth as ImapSettings;
    this.deps = deps;
  }

  /* -------- connection */

  private async connected(): Promise<ImapClient> {
    if (this.client?.usable) return this.client;
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async open(): Promise<ImapClient> {
    this.drop(this.client);
    const client = (this.deps.createClient ?? createImapFlow)(this.settings);
    // An unhandled 'error' event would take the whole process down; the failed command reports the problem.
    client.on("error", () => this.drop(client));
    client.on("close", () => this.drop(client));
    try {
      await client.connect();
    } catch (err) {
      client.close();
      throw friendlyError(err, "IMAP", this.settings.imapHost);
    }
    this.client = client;
    return client;
  }

  private drop(client: ImapClient | undefined): void {
    if (!client) return;
    if (this.client === client) this.client = undefined;
    try {
      client.close();
    } catch {
      // already closed
    }
  }

  /** Run `op` on the live connection; if the connection died under it, reconnect and try once more. */
  private async run<T>(op: (c: ImapClient) => Promise<T>, retry = true): Promise<T> {
    const c = await this.connected();
    try {
      return await op(c);
    } catch (err) {
      if (!c.usable) {
        this.drop(c);
        if (retry) return this.run(op, false);
      }
      // Errors from the wire get a plain-language rewrite; our own messages are already readable.
      throw fromWire(err) ? friendlyError(err, "IMAP", this.settings.imapHost) : err;
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    this.smtp?.close();
    this.smtp = undefined;
    if (c) await c.logout().catch(() => c.close());
  }

  private async layout(c: ImapClient): Promise<Layout> {
    const gmail = c.capabilities.has("X-GM-EXT-1");
    const map = detectMailboxes(await c.list({ listOnly: true }));
    return { gmail, map, targets: syncTargets(map, gmail) };
  }

  /* -------- sync */

  async sync(cursorText: string | null): Promise<SyncPage> {
    const cursor = parseCursor(cursorText);
    const layout = await this.run((c) => this.layout(c));
    const n = layout.targets.length;
    const total = n * 2;
    while (cursor.step < total) {
      this.ctx.signal?.throwIfAborted();
      // Elsewhere the store drops a copy that arrives while its twin still exists, so deletions must come first.
      // Gmail threads by X-GM-THRID, which keeps a thread alive across a move, so there additions go first.
      const checking = (cursor.step < n) === !layout.gmail;
      const target = layout.targets[cursor.step % n]!;
      const res = await this.run((c) => (checking ? this.checkChanges(c, target, layout.gmail, cursor) : this.fetchNew(c, target, layout.gmail, cursor)));
      const content = res.messages.length > 0 || res.flagUpdates.length > 0 || res.deleted.length > 0;
      if (content || res.more) {
        if (!res.more) cursor.step += 1;
        const done = cursor.step >= total;
        if (done) cursor.step = 0;
        return {
          messages: res.messages,
          flagUpdates: res.flagUpdates.length ? res.flagUpdates : undefined,
          deletedRemoteIds: res.deleted.length ? res.deleted : undefined,
          cursor: serializeCursor(cursor),
          done,
        };
      }
      cursor.step += 1;
    }
    cursor.step = 0;
    return { messages: [], cursor: serializeCursor(cursor), done: true };
  }

  /** Flag changes and expunges in mailboxes we already follow. */
  private async checkChanges(c: ImapClient, target: SyncTarget, gmail: boolean, cursor: Cursor): Promise<StepResult> {
    const st = cursor.boxes[target.path];
    if (!st || st.initial) return emptyStep();
    return withMailbox(c, target.path, true, async (mb) => {
      const validity = String(mb.uidValidity);
      if (validity !== st.uidValidity) {
        // The server renumbered the mailbox: start over. Old rows keep their old ids until the store learns to retire them.
        delete cursor.boxes[target.path];
        this.queued.delete(target.path);
        this.signatures.delete(target.path);
        return emptyStep();
      }
      const query: FetchQueryObject = { uid: true, flags: true, labels: gmail || undefined };
      const firstSeq = Math.max(1, mb.exists - WINDOW + 1);
      const win = mb.exists > 0 ? await c.fetchAll(`${firstSeq}:*`, query) : [];
      const known = win.filter((m) => m.uid <= st.lastUid);
      const res = emptyStep();

      for (const uid of findExpunged(
        expandUids(st.window),
        win.map((m) => ({ uid: m.uid, deleted: Boolean(m.flags?.has("\\Deleted")) })),
        firstSeq === 1,
      )) {
        res.deleted.push(remoteIdFor(target.path, validity, uid));
      }
      for (const id of this.moved) {
        if (!id.startsWith(`${target.path}:${validity}:`)) continue;
        this.moved.delete(id);
        if (!res.deleted.includes(id)) res.deleted.push(id);
      }

      const live = known.filter((m) => !m.flags?.has("\\Deleted"));
      const hms = typeof mb.highestModseq === "bigint" && !mb.noModseq ? mb.highestModseq : undefined;
      if (hms !== undefined && st.highestModseq !== undefined) {
        if (BigInt(st.highestModseq) < hms) {
          const changed = await c.fetchAll("1:*", query, { uid: true, changedSince: BigInt(st.highestModseq) });
          for (const m of changed) {
            if (m.uid <= st.lastUid && !m.flags?.has("\\Deleted")) res.flagUpdates.push(flagUpdateOf(m, target, validity, gmail));
          }
        }
      } else {
        const sigs = this.signatures.get(target.path) ?? new Map<number, string>();
        const next = new Map<number, string>();
        for (const m of live) {
          const update = flagUpdateOf(m, target, validity, gmail);
          const sig = flagSignature(update);
          next.set(m.uid, sig);
          if (sigs.get(m.uid) !== sig) res.flagUpdates.push(update);
        }
        this.signatures.set(target.path, next);
      }
      if (hms !== undefined) st.highestModseq = String(hms);
      st.window = compressUids(live.map((m) => m.uid));
      return res;
    });
  }

  /** One batch of mail the store hasn't seen: the first sync (recent mail only) or anything past lastUid. */
  private async fetchNew(c: ImapClient, target: SyncTarget, gmail: boolean, cursor: Cursor): Promise<StepResult> {
    return withMailbox(c, target.path, true, async (mb) => {
      const validity = String(mb.uidValidity);
      let st = cursor.boxes[target.path];
      if (!st || st.uidValidity !== validity) {
        st = {
          uidValidity: validity,
          lastUid: 0,
          highestModseq: typeof mb.highestModseq === "bigint" && !mb.noModseq ? String(mb.highestModseq) : undefined,
          initial: { since: Date.now() - this.ctx.initialSyncDays * DAY_MS, ceiling: mb.uidNext > 0 ? mb.uidNext - 1 : null },
        };
        cursor.boxes[target.path] = st;
        this.queued.delete(target.path);
      }
      const after = st.lastUid;
      const ceiling = st.initial?.ceiling ?? null;
      let uids = this.queued.get(target.path)?.filter((u) => u > after);
      if (!uids) {
        // "N:*" always includes the newest message even when it is older than N, hence the filter.
        const query: SearchObject = { uid: `${after + 1}:${ceiling ?? "*"}` };
        if (st.initial) query.since = new Date(st.initial.since);
        const found = ceiling !== null && after + 1 > ceiling ? [] : ((await c.search(query, { uid: true })) || []);
        uids = found.filter((u) => u > after && (ceiling === null || u <= ceiling)).sort((a, b) => a - b);
      }
      const batch = uids.slice(0, BATCH);
      const rest = uids.slice(BATCH);

      const res = emptyStep();
      if (batch.length) {
        const query: FetchQueryObject = { uid: true, flags: true, internalDate: true, source: true };
        if (gmail) {
          query.labels = true;
          query.threadId = true;
        }
        const fetched = (await c.fetchAll(batch, query, { uid: true })).sort((a, b) => a.uid - b.uid);
        const sigs = this.signatures.get(target.path) ?? new Map<number, string>();
        this.signatures.set(target.path, sigs);
        for (const fm of fetched) {
          try {
            const m = await toIncoming(fm, target, validity, gmail, this.ctx.email);
            if (!m) continue;
            res.messages.push(m);
            // The store has these flags now; the next change check shouldn't announce them again.
            sigs.set(fm.uid, flagSignature(flagUpdateOf(fm, target, validity, gmail)));
            if (sigs.size > WINDOW * 2) sigs.delete(sigs.keys().next().value!);
          } catch (err) {
            // One unreadable message shouldn't stop the mailbox from syncing.
            console.warn(`[slipstream] imap ${target.path} uid ${fm.uid}: skipped, ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      finishBatch(st, batch.at(-1), rest.length);
      if (rest.length) this.queued.set(target.path, rest);
      else this.queued.delete(target.path);
      res.more = rest.length > 0;
      return res;
    });
  }

  /* -------- actions */

  async apply(action: RemoteAction): Promise<{ remoteId?: string }> {
    if (action.kind === "send") {
      await this.send(action.message);
      return {};
    }
    await this.run((c) => this.applyToThread(c, action));
    return {};
  }

  /**
   * UIDs of the thread's messages in the open mailbox. Remote ids go stale when mail moves, so look up by Message-ID;
   * a message without one can only be found by its remote id, and only if that still points into this mailbox.
   */
  private async locate(c: ImapClient, mb: MailboxObject, thread: ThreadRef): Promise<number[]> {
    const uids = new Set<number>();
    const ids: string[] = [];
    const candidates: number[] = [];
    for (const m of thread.messages) {
      const ref = parseRemoteId(m.remoteId);
      if (m.messageIdHeader) ids.push(m.messageIdHeader);
      else if (ref && ref.path === mb.path && ref.validity === String(mb.uidValidity)) candidates.push(ref.uid);
    }
    for (let i = 0; i < ids.length; i += 20) {
      const terms: SearchObject[] = ids.slice(i, i + 20).map((id) => ({ header: { "Message-ID": id } }));
      for (const u of (await c.search(terms.length === 1 ? terms[0]! : { or: terms }, { uid: true })) || []) uids.add(u);
    }
    if (candidates.length) {
      for (const u of (await c.search({ uid: candidates.join(",") }, { uid: true })) || []) uids.add(u);
    }
    return [...uids].sort((a, b) => a - b);
  }

  /** Run `fn` on the thread's messages in each of the given mailboxes (skipping mailboxes where it has none). */
  private async eachMailbox(
    c: ImapClient,
    paths: string[],
    thread: ThreadRef,
    fn: (path: string, uids: number[], mb: MailboxObject) => Promise<void>,
  ): Promise<void> {
    for (const path of paths) {
      await withMailbox(c, path, false, async (mb) => {
        const uids = await this.locate(c, mb, thread);
        if (uids.length) await fn(path, uids, mb);
      });
    }
  }

  /** Move the thread's messages out of `from` into `to`; a function `to` is only called once there is something to move. */
  private async move(c: ImapClient, layout: Layout, from: string[], to: string | (() => Promise<string>), thread: ThreadRef): Promise<void> {
    // Without MOVE imapflow would copy and expunge, and expunging from Gmail's All Mail deletes for good.
    if (layout.gmail && !c.capabilities.has("MOVE")) throw new PermanentProviderError("Gmail's IMAP server did not offer MOVE");
    let dest = typeof to === "string" ? to : undefined;
    await this.eachMailbox(c, from.filter((p) => p !== dest), thread, async (path, uids, mb) => {
      dest ??= await (to as () => Promise<string>)();
      await c.messageMove(uids, dest, { uid: true });
      // Gmail's old rows would otherwise linger beyond the newest-500 window and show up as duplicates.
      if (layout.gmail) for (const uid of uids) this.moved.add(remoteIdFor(path, String(mb.uidValidity), uid));
    });
  }

  private async applyToThread(c: ImapClient, action: Exclude<RemoteAction, { kind: "send" }>): Promise<void> {
    const layout = await this.layout(c);
    const { map, gmail } = layout;
    const everywhere = layout.targets.map((t) => t.path);
    const inbox = map.inbox ?? "INBOX";
    const need = (role: "trash" | "junk") => {
      const path = map[role];
      if (!path) throw new PermanentProviderError(`This account has no ${role === "trash" ? "Trash" : "Junk"} folder`);
      return path;
    };
    const pathsExcept = (...roles: MailboxRole[]) => layout.targets.filter((t) => !roles.includes(t.role)).map((t) => t.path);

    switch (action.kind) {
      case "markRead":
      case "markUnread":
      case "star":
      case "unstar": {
        const flag = action.kind === "markRead" || action.kind === "markUnread" ? "\\Seen" : "\\Flagged";
        const add = action.kind === "markRead" || action.kind === "star";
        // Like the local store and Gmail: "unread" marks only the newest message (messages come oldest first).
        const target = action.kind === "markUnread" ? { ...action, messages: action.messages.slice(-1) } : action;
        await this.eachMailbox(c, everywhere, target, async (_p, uids) => {
          await (add ? c.messageFlagsAdd(uids, [flag], { uid: true }) : c.messageFlagsRemove(uids, [flag], { uid: true }));
        });
        return;
      }
      case "archive":
        if (gmail) {
          await this.eachMailbox(c, [map.all!], action, async (_p, uids) => {
            await c.messageFlagsRemove(uids, ["\\Inbox"], { uid: true, useLabels: true });
          });
          return;
        }
        await this.move(c, layout, [inbox], () => this.archiveFolder(c, layout), action);
        return;
      case "unarchive":
        if (gmail) {
          await this.eachMailbox(c, [map.all!], action, async (_p, uids) => {
            await c.messageFlagsAdd(uids, ["\\Inbox"], { uid: true, useLabels: true });
          });
          return;
        }
        if (map.archive) await this.move(c, layout, [map.archive], inbox, action);
        return;
      case "trash":
        await this.move(c, layout, pathsExcept("trash"), need("trash"), action);
        return;
      case "untrash":
        await this.move(c, layout, [need("trash")], inbox, action);
        return;
      case "spam":
        await this.move(c, layout, pathsExcept("trash", "junk"), need("junk"), action);
        return;
      case "unspam":
        await this.move(c, layout, [need("junk")], inbox, action);
        return;
      case "addLabel":
      case "removeLabel": {
        const add = action.kind === "addLabel";
        if (gmail) {
          await this.eachMailbox(c, [map.all!], action, async (_p, uids) => {
            await (add
              ? c.messageFlagsAdd(uids, [action.label.name], { uid: true, useLabels: true })
              : c.messageFlagsRemove(uids, [action.label.name], { uid: true, useLabels: true }));
          });
          return;
        }
        const keyword = keywordFor(action.label.name);
        if (!keyword) return;
        await this.eachMailbox(c, everywhere, action, async (_p, uids, mb) => {
          // Servers that don't allow custom keywords can't store labels; that is a no-op, not an error.
          if (mb.permanentFlags && !mb.permanentFlags.has("\\*") && !mb.permanentFlags.has(keyword)) return;
          await (add ? c.messageFlagsAdd(uids, [keyword], { uid: true }) : c.messageFlagsRemove(uids, [keyword], { uid: true }));
        });
        return;
      }
    }
  }

  private async archiveFolder(c: ImapClient, layout: Layout): Promise<string> {
    if (layout.map.archive) return layout.map.archive;
    const made = await c.mailboxCreate("Archive");
    layout.map.archive = made.path;
    return made.path;
  }

  /* -------- sending */

  private async send(m: OutgoingMessage): Promise<void> {
    const recipients = [...new Set([...m.to, ...m.cc, ...m.bcc].map((a) => a.email.trim().toLowerCase()).filter(Boolean))];
    if (recipients.length === 0) throw new PermanentProviderError("The message has no recipients");
    this.smtp ??= (this.deps.createTransport ?? createSmtp)(this.settings);
    try {
      // The envelope carries the Bcc recipients; the bytes on the wire must not name them.
      await this.smtp.sendMail({ envelope: { from: m.from.email, to: recipients }, raw: stripBccHeader(m.raw) });
    } catch (err) {
      const friendly = friendlyError(err, "SMTP", this.settings.smtpHost);
      if (friendly instanceof ProviderAuthError) throw friendly;
      // A 5xx answer means the server will never take this message; retrying only repeats the refusal.
      if (((err ?? {}) as RawError).responseCode! >= 500) {
        throw new PermanentProviderError(`The mail server refused the message: ${friendly.message}`);
      }
      throw friendly;
    }
    if (savesSentMail(this.settings.imapHost)) return;
    // The message is gone; failing to file a copy must not make the queue send it again.
    await this.saveToSent(m.raw).catch((err) => {
      console.warn(`[slipstream] imap: sent, but couldn't save a copy to Sent: ${err instanceof Error ? err.message : err}`);
    });
  }

  private async saveToSent(raw: Buffer): Promise<void> {
    await this.run(async (c) => {
      const sent = (await this.layout(c)).map.sent;
      if (!sent) throw new Error("no Sent folder found");
      await c.append(sent, raw, ["\\Seen"], new Date());
    });
  }

  /* -------- attachments */

  async fetchAttachment(messageRemoteId: string, attachmentRemoteId: string): Promise<Buffer> {
    const ref = parseRemoteId(messageRemoteId);
    if (!ref) throw new Error("Unrecognized message id");
    const source = await this.run((c) =>
      withMailbox(c, ref.path, true, async (mb) => {
        if (String(mb.uidValidity) !== ref.validity) throw new Error("The mailbox was renumbered by the server; sync again to download this attachment");
        const msg = await c.fetchOne(String(ref.uid), { source: true }, { uid: true });
        if (!msg || !msg.source) throw new Error("The message is no longer in that mailbox");
        return msg.source;
      }),
    );
    return extractAttachment(source, attachmentRemoteId);
  }
}
