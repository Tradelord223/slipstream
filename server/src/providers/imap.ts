import {
  ImapFlow,
  type FetchMessageObject,
  type FetchQueryObject,
  type ListResponse,
  type MailboxObject,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import { extractAttachment, parseHeaderBlock, parseRaw, previewFromPart } from "../mail/mime.ts";
import { imapGmailSearch, imapSearch } from "../mail/remote-query.ts";
import {
  PermanentProviderError,
  ProviderAuthError,
  type FlagUpdate,
  type Folders,
  type FullBody,
  type IncomingAttachment,
  type IncomingMessage,
  type MailProvider,
  type OutgoingMessage,
  type ProviderContext,
  type ProviderQuery,
  type RemoteAction,
  type SortingHints,
  type SyncPage,
  type SyncStageProgress,
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

export function createImapFlow(s: ImapSettings): ImapFlow {
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
/** Messages per page of summaries. */
const BATCH = 100;
/** The newest inbox mail is its own first page: what the dashboard needs to open. */
const INBOX_PAGE = 100;
const DAY_MS = 86_400_000;
/** How much of a message's text part a summary reads for its preview. */
const PREVIEW_BYTES = 2048;
/** Whole messages asked for in one FETCH. Gmail returns 50 in about the time it takes to preview 20, and a chunk is held in memory until it is parsed. */
const BODY_BATCH = 50;
/** The headers a summary needs; the rest of the header block (Received, DKIM) is never downloaded. */
const HEADER_FIELDS = [
  "From", "To", "Cc", "Bcc", "Reply-To", "Subject", "Date", "Message-ID", "In-Reply-To", "References",
  "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted",
];
/** What the re-sort of old mail downloads again: the four headers that say a message is from a list or a machine. */
const SORTING_HEADERS = ["List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"];
/** Response codes (RFC 5530) that say "try again later" rather than "no": a NO with one of these is not a refusal of the search. */
const TRY_AGAIN_CODES = new Set(["UNAVAILABLE", "THROTTLED", "INUSE"]);
/** Gmail's tabs as X-GM-RAW knows them. Personal comes last: it overlaps Primary, the others are exclusive. */
const GMAIL_TABS = ["promotions", "social", "updates", "forums", "personal"];

interface BoxState {
  /** bigint, as a string: JSON can't carry bigints. */
  uidValidity: string;
  /** Everything up to here has been handed to the store. */
  lastUid: number;
  highestModseq?: string;
  /** UIDs of the newest messages as of the last change check, as "1:5,7"; the next check diffs against it to find expunges. */
  window?: string;
  /**
   * Set while the first sync of this mailbox is still working through its window, newest first.
   * `low`: every window UID at or above it has been handed to the store. `top`: the inbox page has gone.
   */
  initial?: { since: number; ceiling: number | null; low?: number; top?: true };
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
  st.lastUid = Math.max(st.lastUid, lastInBatch ?? 0);
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

/** What a message's MIME structure says without downloading it: which part is the text, and the attachments. */
export function describeStructure(root: MessageStructureObject | undefined): {
  text?: { key: string; type: string; encoding?: string; charset?: string };
  attachments: IncomingAttachment[];
} {
  if (!root) return { attachments: [] };
  const leaves: MessageStructureObject[] = [];
  const walk = (n: MessageStructureObject) => {
    // An attached message is one attachment, not a place to look for text.
    if (n.childNodes?.length && n.type !== "message/rfc822") n.childNodes.forEach(walk);
    else leaves.push(n);
  };
  walk(root);
  const named = (n: MessageStructureObject) => n.dispositionParameters?.filename ?? n.parameters?.name;
  const isBody = (n: MessageStructureObject) => /^text\/(plain|html)$/.test(n.type) && n.disposition !== "attachment" && !named(n);
  const chosen = leaves.find((n) => n.type === "text/plain" && isBody(n)) ?? leaves.find((n) => n.type === "text/html" && isBody(n));
  const attachments = leaves
    .filter((n) => !isBody(n))
    .map((n): IncomingAttachment => {
      const contentId = n.id?.replace(/^<|>$/g, "").trim() || undefined;
      const encoded = n.size ?? 0;
      return {
        remoteId: `part:${n.part ?? "1"}`,
        filename: named(n) || (n.type === "message/rfc822" ? "message.eml" : "attachment"),
        mimeType: n.type,
        size: n.encoding === "base64" ? Math.floor((encoded * 3) / 4) : encoded,
        contentId,
        inline: n.disposition === "inline" && Boolean(contentId),
      };
    });
  return {
    text: chosen ? { key: chosen.part ?? "1", type: chosen.type, encoding: chosen.encoding, charset: chosen.parameters?.charset } : undefined,
    attachments,
  };
}

/** A summary: headers, the attachment list and the server's size; no body and no preview, which `fetchPreviews` adds. */
async function toSummary(
  fm: FetchMessageObject,
  target: SyncTarget,
  validity: string,
  gmail: boolean,
  selfEmail: string,
  providerCategory?: string,
): Promise<IncomingMessage | null> {
  const s = stateOf(fm, target, gmail);
  if (s.skip) return null;
  const message = await parseHeaderBlock(fm.headers ?? Buffer.alloc(0), {
    remoteId: remoteIdFor(target.path, validity, fm.uid),
    remoteThreadId: gmail ? fm.threadId : undefined,
    folders: s.folders,
    unread: s.unread,
    starred: s.starred,
    labels: s.labels,
    selfEmail,
    receivedAt: fm.internalDate ? new Date(fm.internalDate).getTime() : undefined,
  });
  const { attachments } = describeStructure(fm.bodyStructure);
  // Ours means "in the Sent folder" (aliases included), never "the From header says so": anyone can write a From.
  message.outgoing = Boolean(s.folders.sent);
  message.providerCategory = providerCategory;
  message.bodyText = "";
  message.bodyComplete = false;
  message.size = fm.size;
  message.attachments = attachments;
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
  /** Set by pages of a first sync. */
  progress?: SyncStageProgress;
  /** Remote ids of the messages in `messages` whose preview `fetchPreviews` can bring. */
  previews: string[];
}

/** A search's continuation token: for each mailbox with hits left, the UID to search below. */
function parseSearchToken(token: string | undefined): Record<string, number> | undefined {
  if (token === undefined) return undefined;
  try {
    const o = JSON.parse(token) as Record<string, unknown>;
    const entries = Object.entries(o);
    if (typeof o === "object" && o !== null && entries.every(([, v]) => Number.isInteger(v) && (v as number) > 0)) return o as Record<string, number>;
  } catch {
    // falls through
  }
  throw new Error("That search can't be continued; run it again");
}

const emptyStep = (): StepResult => ({ messages: [], flagUpdates: [], deleted: [], more: false, previews: [] });

/** The mailbox whose newest mail is the "inbox" page: Gmail's All Mail (its inbox is a label), otherwise INBOX. */
const isInboxTarget = (t: SyncTarget, gmail: boolean) => t.role === (gmail ? "all" : "inbox");

interface Layout {
  gmail: boolean;
  map: MailboxMap;
  targets: SyncTarget[];
}

/** Where to find a message's text part for its preview. */
interface PreviewRef {
  path: string;
  validity: string;
  uid: number;
  part: { key: string; type: string; encoding?: string; charset?: string };
}

/** Summaries waiting for a preview that no pass asked for (a sync that stopped) are dropped oldest first beyond this many. */
const PREVIEWABLE_MAX = 5000;
/** A mailbox list is reused this long while a first sync is under way. */
const LAYOUT_TTL_MS = 60_000;

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
  /**
   * UIDs still to fetch, per mailbox: spares re-running a large SEARCH for every batch. The first sync's list is newest
   * first, with the inbox page (the first `top` UIDs) at the front; later mail is oldest first.
   */
  private queued = new Map<string, { uids: number[]; top: number; inboxOnly?: true }>();
  /** Gmail: the inbox page's UIDs, kept until the rest of the window has been listed, so that list leaves them out. */
  private handed = new Map<string, Set<number>>();
  /** Where each summarized message's text part is, until its preview has been fetched. */
  private previewable = new Map<string, PreviewRef>();
  /** The mailbox list, kept while a first sync works through its pages: LIST is a round trip per page otherwise. */
  private layoutCache?: { layout: Layout; at: number };
  /** Messages the first sync's window holds beyond the inbox page, once every mailbox has been counted. */
  private historyTotal?: number;
  /** Last flags sent per mailbox window, so an unchanged message isn't re-announced every round. */
  private signatures = new Map<string, Map<number, string>>();
  /** Gmail: remote ids of messages we moved out of a mailbox, to retire even if they're outside the change window. */
  private moved = new Set<string>();
  /** Gmail: UIDs of first-sync mail whose tab has not been looked up yet; the next page carries it, so no page waits for it. */
  private pendingTabs: { path: string; validity: string; uids: number[] }[] = [];

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

  /** The mailbox list; a first sync reads it once rather than before every page. */
  private async cachedLayout(c: ImapClient, cursor: Cursor): Promise<Layout> {
    const cache = this.layoutCache;
    const firstSync = Object.values(cursor.boxes).some((b) => b.initial);
    if (cache && firstSync && Date.now() - cache.at < LAYOUT_TTL_MS) return cache.layout;
    const layout = await this.layout(c);
    this.layoutCache = { layout, at: Date.now() };
    return layout;
  }

  private async layout(c: ImapClient): Promise<Layout> {
    const gmail = c.capabilities.has("X-GM-EXT-1");
    const map = detectMailboxes(await c.list({ listOnly: true }));
    return { gmail, map, targets: syncTargets(map, gmail) };
  }

  /* -------- sync */

  async sync(cursorText: string | null): Promise<SyncPage> {
    // The Gmail tabs of mail the last page handed over ride along with this page. If the page fails, they are looked up again.
    const pending = this.pendingTabs;
    this.pendingTabs = [];
    try {
      return await this.syncPage(cursorText, await this.readTabs(pending));
    } catch (err) {
      this.pendingTabs.unshift(...pending);
      throw err;
    }
  }

  private async syncPage(cursorText: string | null, carry: FlagUpdate[]): Promise<SyncPage> {
    const cursor = parseCursor(cursorText);
    const layout = await this.run((c) => this.cachedLayout(c, cursor));
    const n = layout.targets.length;
    const total = n * 2;
    if (Object.keys(cursor.boxes).length === 0) {
      this.queued.clear();
      this.handed.clear();
      this.historyTotal = undefined;
    }
    while (cursor.step < total) {
      this.ctx.signal?.throwIfAborted();
      // Elsewhere the store drops a copy that arrives while its twin still exists, so deletions must come first.
      // Gmail threads by X-GM-THRID, which keeps a thread alive across a move, so there additions go first.
      const checking = (cursor.step < n) === !layout.gmail;
      const target = layout.targets[cursor.step % n]!;
      if (!checking) await this.countWindow(layout, cursor);
      const res = await this.run((c) => (checking ? this.checkChanges(c, target, layout.gmail, cursor) : this.fetchNew(c, target, layout.gmail, cursor)));
      const content = res.messages.length > 0 || res.flagUpdates.length > 0 || res.deleted.length > 0 || res.progress !== undefined;
      if (content || res.more) {
        if (!res.more) cursor.step += 1;
        const done = cursor.step >= total;
        if (done) cursor.step = 0;
        const flagUpdates = [...res.flagUpdates, ...carry];
        return {
          messages: res.messages,
          flagUpdates: flagUpdates.length ? flagUpdates : undefined,
          deletedRemoteIds: res.deleted.length ? res.deleted : undefined,
          cursor: serializeCursor(cursor),
          done,
          progress: res.progress?.stage === "history" ? { ...res.progress, last: done } : res.progress,
          previewIds: res.previews.length ? res.previews : undefined,
        };
      }
      cursor.step += 1;
    }
    cursor.step = 0;
    return { messages: [], flagUpdates: carry.length ? carry : undefined, cursor: serializeCursor(cursor), done: true };
  }

  /** The Gmail tabs of mail an earlier page left to look up, as updates to that mail. */
  private async readTabs(pending: { path: string; validity: string; uids: number[] }[]): Promise<FlagUpdate[]> {
    const updates: FlagUpdate[] = [];
    for (const p of pending) {
      await this.run((c) =>
        withMailbox(c, p.path, true, async (mb) => {
          if (String(mb.uidValidity) !== p.validity) return;
          const tabs = await this.gmailTabs(c, p.uids);
          // Answered for every message asked about, so one in no tab is finished too and not looked up again.
          for (const uid of p.uids) updates.push({ remoteId: remoteIdFor(p.path, p.validity, uid), providerCategory: tabs.get(uid), tabLookedUp: true });
        }),
      );
    }
    return updates;
  }

  /**
   * Once the inbox page has gone out, count the rest of the first sync's window in every mailbox, so the history stage can
   * report an exact total. Each mailbox is searched once and its list kept for the batches that follow.
   */
  private async countWindow(layout: Layout, cursor: Cursor): Promise<void> {
    if (this.historyTotal !== undefined) return;
    const inbox = layout.targets.find((t) => isInboxTarget(t, layout.gmail));
    const inboxBox = inbox && cursor.boxes[inbox.path];
    if (!inboxBox || (inboxBox.initial && !inboxBox.initial.top)) return;
    const pending = layout.targets.filter((t) => cursor.boxes[t.path]?.initial !== undefined || !cursor.boxes[t.path]);
    if (pending.length === 0) return;
    for (const t of pending) {
      await this.run((c) => withMailbox(c, t.path, true, (mb) => this.listWindow(c, mb, t, layout.gmail, cursor)));
    }
    this.historyTotal = pending.reduce((sum, t) => {
      const q = this.queued.get(t.path);
      return sum + (q ? q.uids.length - q.top : 0);
    }, 0);
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

  /**
   * Opens the first sync of a mailbox if it hasn't started (or the server renumbered it) and lists the window's UIDs
   * newest first, with the inbox page in front. A list already made in this run is kept.
   */
  private async listWindow(c: ImapClient, mb: MailboxObject, target: SyncTarget, gmail: boolean, cursor: Cursor): Promise<BoxState> {
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
      this.handed.delete(target.path);
    }
    const init = st.initial;
    if (!init || this.queued.has(target.path)) return st;

    // UIDs not yet handed over: below `low` once a batch has gone, otherwise up to the UIDNEXT this sync started from.
    const upper = init.low !== undefined ? init.low - 1 : init.ceiling;
    const since = new Date(init.since);
    const search = async (extra: SearchObject) => {
      if (upper !== null && upper < 1) return [];
      const found = (await c.search({ ...extra, uid: `1:${upper ?? "*"}`, since }, { uid: true })) || [];
      return found.filter((u) => upper === null || u <= upper).sort((a, b) => b - a);
    };
    if (!init.top && isInboxTarget(target, gmail) && gmail) {
      // Gmail's inbox is a label on All Mail, so its newest inbox mail is found with Gmail's own search. Only that search
      // stands between the inbox and the first page; the whole window is listed once the page has gone.
      const first = (await search({ gmraw: "in:inbox" })).slice(0, INBOX_PAGE);
      this.queued.set(target.path, { uids: first, top: first.length, inboxOnly: true });
      return st;
    }
    let uids = await search({});
    const handed = this.handed.get(target.path);
    if (handed) {
      uids = uids.filter((u) => !handed.has(u));
      this.handed.delete(target.path);
    }
    const top = !init.top && isInboxTarget(target, gmail) ? Math.min(INBOX_PAGE, uids.length) : 0;
    this.queued.set(target.path, { uids, top });
    return st;
  }

  /** One page of mail the store hasn't seen: the first sync's window (newest first) or anything past lastUid. */
  private async fetchNew(c: ImapClient, target: SyncTarget, gmail: boolean, cursor: Cursor): Promise<StepResult> {
    return withMailbox(c, target.path, true, async (mb) => {
      const st = await this.listWindow(c, mb, target, gmail, cursor);
      const validity = String(mb.uidValidity);
      const res = emptyStep();

      if (st.initial) {
        const init = st.initial;
        const queue = this.queued.get(target.path) ?? { uids: [], top: 0 };
        const inboxPage = !init.top && isInboxTarget(target, gmail);
        const size = inboxPage ? queue.top : BATCH;
        const batch = queue.uids.slice(0, size);
        const rest = queue.uids.slice(size);
        await this.summarize(c, batch, target, gmail, validity, res, true);
        // A page of newest mail is a block at the top of the window; Gmail's inbox page is scattered through it.
        if (batch.length && !(inboxPage && gmail)) init.low = Math.min(...batch);
        if (inboxPage) {
          init.top = true;
          res.progress = { stage: "inbox", total: queue.top, count: batch.length, last: true };
        } else if (batch.length) {
          res.progress = { stage: "history", total: this.historyTotal ?? null, count: batch.length };
        }
        if (queue.inboxOnly) {
          // The rest of the window is still to be listed, not finished: the next call lists it without these.
          this.handed.set(target.path, new Set(batch));
          this.queued.delete(target.path);
          res.more = true;
          return res;
        }
        if (rest.length) this.queued.set(target.path, { uids: rest, top: 0 });
        else {
          // The window is done. Mail past the UIDNEXT it started from comes in as new mail next round.
          this.queued.delete(target.path);
          st.lastUid = Math.max(st.lastUid, init.ceiling ?? 0);
          delete st.initial;
        }
        res.more = rest.length > 0;
        return res;
      }

      const after = st.lastUid;
      let uids = this.queued.get(target.path)?.uids.filter((u) => u > after);
      if (!uids) {
        // "N:*" always includes the newest message even when it is older than N, hence the filter.
        const found = (await c.search({ uid: `${after + 1}:*` }, { uid: true })) || [];
        uids = found.filter((u) => u > after).sort((a, b) => a - b);
      }
      const batch = uids.slice(0, BATCH);
      const rest = uids.slice(BATCH);
      await this.summarize(c, batch, target, gmail, validity, res);
      finishBatch(st, batch.at(-1), rest.length);
      if (rest.length) this.queued.set(target.path, { uids: rest, top: 0 });
      else this.queued.delete(target.path);
      res.more = rest.length > 0;
      return res;
    });
  }

  /**
   * Summaries for a batch of UIDs in the open mailbox: one fetch for headers, structure, size and flags. Previews are not
   * part of it, so the page can go out as soon as this returns; `fetchPreviews` brings them right after.
   */
  private async summarize(c: ImapClient, uids: number[], target: SyncTarget, gmail: boolean, validity: string, res: StepResult, deferTabs = false): Promise<void> {
    if (uids.length === 0) return;
    const query: FetchQueryObject = { uid: true, flags: true, internalDate: true, size: true, bodyStructure: true, headers: HEADER_FIELDS };
    if (gmail) {
      query.labels = true;
      query.threadId = true;
    }
    const fetched = (await c.fetchAll(uids, query, { uid: true })).sort((a, b) => a.uid - b.uid);
    // Gmail's own sorting, one search per tab for the whole batch (All Mail only: Trash and Spam have no tabs). The first sync
    // looks them up after the page has gone, so the inbox opens as fast as it did before.
    let tabs = new Map<number, string>();
    const deferred = gmail && target.role === "all" && deferTabs;
    if (gmail && target.role === "all") {
      if (deferred) this.pendingTabs.push({ path: target.path, validity, uids: [...uids] });
      else tabs = await this.gmailTabs(c, uids);
    }

    const sigs = this.signatures.get(target.path) ?? new Map<number, string>();
    this.signatures.set(target.path, sigs);
    for (const fm of fetched) {
      try {
        const m = await toSummary(fm, target, validity, gmail, this.ctx.email, tabs.get(fm.uid));
        if (!m) continue;
        // Kept in memory only: stored as not yet sorted until the lookup lands, so a restart in between loses nothing.
        if (deferred) m.tabPending = true;
        res.messages.push(m);
        const part = describeStructure(fm.bodyStructure).text;
        if (part) {
          this.previewable.set(m.remoteId, { path: target.path, validity, uid: fm.uid, part });
          res.previews.push(m.remoteId);
          if (this.previewable.size > PREVIEWABLE_MAX) this.previewable.delete(this.previewable.keys().next().value!);
        }
        // The store has these flags now; the next change check shouldn't announce them again.
        sigs.set(fm.uid, flagSignature(flagUpdateOf(fm, target, validity, gmail)));
        if (sigs.size > WINDOW * 2) sigs.delete(sigs.keys().next().value!);
      } catch (err) {
        // One unreadable message shouldn't stop the mailbox from syncing.
        console.warn(`[slipstream] imap ${target.path} uid ${fm.uid}: skipped, ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * The first lines of each message's text part, for messages `sync` listed in `previewIds`: one FETCH per mailbox that asks
   * for every distinct text part the batch needs, since a round trip costs far more than the bytes. A message answers only
   * the part it was asked for; the others come back empty or not at all.
   */
  async fetchPreviews(remoteIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const byPath = new Map<string, { id: string; ref: PreviewRef }[]>();
    for (const id of remoteIds) {
      const ref = this.previewable.get(id);
      if (!ref) continue;
      byPath.set(ref.path, [...(byPath.get(ref.path) ?? []), { id, ref }]);
    }
    for (const [path, entries] of byPath) {
      try {
        await this.run((c) =>
          withMailbox(c, path, true, async (mb) => {
            const live = entries.filter((e) => e.ref.validity === String(mb.uidValidity));
            if (live.length === 0) return;
            // One FETCH per kind of text part, naming only the messages that have it: Gmail refuses a whole FETCH
            // ("Some messages could not be FETCHed") when it names a part one of the messages lacks.
            // The most common layout goes first, so most of the inbox gets its previews soonest.
            const groups = new Map<string, typeof live>();
            for (const e of live) groups.set(e.ref.part.key, [...(groups.get(e.ref.part.key) ?? []), e]);
            for (const [key, group] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
              const got = await c.fetchAll(group.map((e) => e.ref.uid), { uid: true, bodyParts: [{ key, maxLength: PREVIEW_BYTES }] }, { uid: true });
              const byUid = new Map(got.map((fm) => [fm.uid, fm]));
              for (const { id, ref } of group) {
                const bytes = byUid.get(ref.uid)?.bodyParts?.get(key);
                if (bytes) out.set(id, previewFromPart(bytes, ref.part));
              }
            }
          }),
        );
      } finally {
        for (const e of entries) this.previewable.delete(e.id);
      }
    }
    return out;
  }

  /**
   * Gmail's tab for each of these UIDs in the open mailbox, found with one X-GM-RAW search per tab over the whole set (Gmail
   * keeps the tabs as labels IMAP doesn't list). A message in no tab is left out. If Gmail refuses the search (a BAD or NO answer),
   * the messages are sorted by their headers alone, and the sync goes on. Any other failure (a dropped connection, a timeout)
   * says nothing about the tabs, so it throws and the caller asks again; it is never kept as "no tab".
   */
  private async gmailTabs(c: ImapClient, uids: number[]): Promise<Map<number, string>> {
    const found = new Map<number, string>();
    if (uids.length === 0) return found;
    const set = compressUids([...uids].sort((a, b) => a - b));
    try {
      for (const tab of GMAIL_TABS) {
        if (found.size === uids.length) break;
        for (const uid of (await c.search({ gmraw: `category:${tab}`, uid: set }, { uid: true })) || []) if (!found.has(uid)) found.set(uid, tab);
      }
    } catch (err) {
      const { responseStatus: status, serverResponseCode: code } = (err ?? {}) as { responseStatus?: unknown; serverResponseCode?: unknown };
      if ((status !== "NO" && status !== "BAD") || TRY_AGAIN_CODES.has(String(code))) throw err;
      console.warn(`[slipstream] gmail tabs for ${this.ctx.email}: ${err instanceof Error ? err.message : err}`);
    }
    return found;
  }

  /** The list headers and, on Gmail, the tab of messages stored before Slipstream kept them: headers only, by UID, mailbox by mailbox. */
  async fetchSortingHints(refs: { remoteId: string }[]): Promise<Map<string, SortingHints>> {
    const out = new Map<string, SortingHints>();
    const byPath = new Map<string, { remoteId: string; validity: string; uid: number }[]>();
    for (const r of refs) {
      const ref = parseRemoteId(r.remoteId);
      if (ref) byPath.set(ref.path, [...(byPath.get(ref.path) ?? []), { remoteId: r.remoteId, validity: ref.validity, uid: ref.uid }]);
    }
    if (byPath.size === 0) return out;
    const known = this.layoutCache && Date.now() - this.layoutCache.at < LAYOUT_TTL_MS ? this.layoutCache.layout : undefined;
    const layout = known ?? (await this.run((c) => this.layout(c)));
    for (const [path, entries] of byPath) {
      await this.run((c) =>
        withMailbox(c, path, true, async (mb) => {
          // A renumbered mailbox has new UIDs: these ones can't be found.
          const live = entries.filter((e) => e.validity === String(mb.uidValidity));
          if (live.length === 0) return;
          const got = await c.fetchAll(live.map((e) => e.uid), { uid: true, headers: SORTING_HEADERS }, { uid: true });
          const tabs = layout.gmail && path === layout.map.all ? await this.gmailTabs(c, got.map((fm) => fm.uid)) : new Map<number, string>();
          const byUid = new Map(live.map((e) => [e.uid, e.remoteId]));
          for (const fm of got) {
            const remoteId = byUid.get(fm.uid);
            if (!remoteId) continue;
            const parsed = await parseHeaderBlock(fm.headers ?? Buffer.alloc(0), { remoteId });
            out.set(remoteId, { listUnsubscribe: parsed.listUnsubscribe, listId: parsed.listId, bulk: Boolean(parsed.bulk), providerCategory: tabs.get(fm.uid) });
          }
        }),
      );
    }
    return out;
  }

  /* -------- search */

  /**
   * Search the server. Gmail answers its own query language in All Mail (X-GM-RAW). Any other server is asked with plain
   * SEARCH in the Inbox, Sent and the archive folder, and the newest hits of the three are merged. A continuation token
   * records, for each mailbox that still has hits, the UID to search below. Summaries come back without previews; the ones
   * `fetchPreviews` can supply are queued for it, like the sync's.
   */
  async search(query: ProviderQuery, opts: { limit: number; pageToken?: string }): Promise<{ messages: IncomingMessage[]; next?: string }> {
    const below = parseSearchToken(opts.pageToken);
    return this.run(async (c) => {
      const layout = await this.layout(c);
      const targets: SyncTarget[] = layout.gmail
        ? syncTargets(layout.map, true).filter((t) => t.role === "all")
        : (["inbox", "sent", "archive"] as const).flatMap((role) => {
            const path = layout.map[role] ?? (role === "inbox" ? "INBOX" : undefined);
            return path ? [{ path, role }] : [];
          });
      const criteria = layout.gmail ? imapGmailSearch(query) : imapSearch(query);

      const found: { target: SyncTarget; validity: string; total: number; top: number; rows: { m: IncomingMessage; uid: number; fm: FetchMessageObject }[] }[] = [];
      for (const target of targets.filter((t) => !below || below[t.path] !== undefined)) {
        const upper = below?.[target.path];
        if (upper !== undefined && upper < 2) continue;
        const one = await withMailbox(c, target.path, true, async (mb) => {
          const hits = ((await c.search({ ...criteria, ...(upper !== undefined ? { uid: `1:${upper - 1}` } : {}) }, { uid: true })) || []).sort((a, b) => b - a);
          const wanted = hits.slice(0, opts.limit);
          const what: FetchQueryObject = { uid: true, flags: true, internalDate: true, size: true, bodyStructure: true, headers: HEADER_FIELDS };
          if (layout.gmail) {
            what.labels = true;
            what.threadId = true;
          }
          const fetched = wanted.length ? await c.fetchAll(wanted, what, { uid: true }) : [];
          const rows: { m: IncomingMessage; uid: number; fm: FetchMessageObject }[] = [];
          for (const fm of fetched) {
            const m = await toSummary(fm, target, String(mb.uidValidity), layout.gmail, this.ctx.email);
            if (m) rows.push({ m, uid: fm.uid, fm });
          }
          return { target, validity: String(mb.uidValidity), total: hits.length, top: wanted[0] ?? 0, rows };
        });
        found.push(one);
      }

      // Newest first across the mailboxes; what doesn't fit waits for the next page.
      const all = found.flatMap((f) => f.rows.map((r) => ({ ...r, f })));
      all.sort((a, b) => b.m.sentAt - a.m.sentAt);
      const kept = all.slice(0, opts.limit);
      const resume: Record<string, number> = {};
      for (const f of found) {
        const mine = kept.filter((k) => k.f === f);
        if (f.total - mine.length <= 0) continue;
        resume[f.target.path] = mine.length ? Math.min(...mine.map((k) => k.uid)) : (below?.[f.target.path] ?? f.top + 1);
      }
      for (const k of kept) {
        const part = describeStructure(k.fm.bodyStructure).text;
        if (part) this.previewable.set(k.m.remoteId, { path: k.f.target.path, validity: k.f.validity, uid: k.uid, part });
      }
      while (this.previewable.size > PREVIEWABLE_MAX) this.previewable.delete(this.previewable.keys().next().value!);
      return { messages: kept.map((k) => k.m), next: Object.keys(resume).length ? JSON.stringify(resume) : undefined };
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

  /**
   * The whole message, for one that was synced as a summary. The id names a mailbox, its UIDVALIDITY and a UID; if the
   * server has renumbered the mailbox or the message moved, it is found again by Message-ID.
   */
  async fetchBody(messageRemoteId: string, hint?: { messageIdHeader?: string | null }): Promise<FullBody> {
    const ref = parseRemoteId(messageRemoteId);
    if (!ref) throw new Error("Unrecognized message id");
    const source = await this.run(async (c) => {
      const fetchSource = async (uid: number) => ((await c.fetchOne(String(uid), { source: true }, { uid: true })) || undefined)?.source;
      let exact: Buffer | undefined;
      try {
        exact = await withMailbox(c, ref.path, true, async (mb) => (String(mb.uidValidity) === ref.validity ? fetchSource(ref.uid) : undefined));
      } catch (err) {
        // A mailbox that is gone is the same as a message that moved out of it; anything else is a real failure.
        if (!(hint?.messageIdHeader && (err as { mailboxMissing?: boolean }).mailboxMissing)) throw err;
      }
      if (exact) return exact;
      if (!hint?.messageIdHeader) throw new Error("The message is no longer in that mailbox");
      const found = await this.sourceByMessageId(c, (await this.layout(c)).targets, messageRemoteId, hint.messageIdHeader);
      if (!found) throw new Error("The message is no longer in this mailbox");
      return found;
    });
    const { message } = await parseRaw(source, { remoteId: messageRemoteId });
    return { text: message.bodyText, html: message.bodyHtml, attachments: message.attachments };
  }

  /** A message that moved or whose mailbox was renumbered, found again by its Message-ID in each mailbox in turn. */
  private async sourceByMessageId(c: ImapClient, targets: SyncTarget[], remoteId: string, messageIdHeader: string): Promise<Buffer | undefined> {
    const thread: ThreadRef = { threadRemoteId: "", messages: [{ remoteId, messageIdHeader }] };
    for (const t of targets) {
      const found = await withMailbox(c, t.path, true, async (mb) => {
        const uid = (await this.locate(c, mb, thread))[0];
        return uid === undefined ? undefined : ((await c.fetchOne(String(uid), { source: true }, { uid: true })) || undefined)?.source;
      });
      if (found) return found;
    }
    return undefined;
  }

  /**
   * `fetchBody` for many messages: one FETCH of the sources per mailbox for every 50 of them, since a round trip costs far
   * more than the bytes. A message whose mailbox was renumbered or that moved is found again by Message-ID, one at a time;
   * one that is gone, or can't be read, is left out of the answer.
   */
  async fetchBodies(refs: { remoteId: string; messageIdHeader?: string | null }[]): Promise<Map<string, FullBody>> {
    const out = new Map<string, FullBody>();
    const byPath = new Map<string, { remoteId: string; uid: number; validity: string; messageIdHeader?: string | null }[]>();
    const unmatched: typeof refs = [];
    for (const r of refs) {
      const ref = parseRemoteId(r.remoteId);
      if (!ref) continue;
      byPath.set(ref.path, [...(byPath.get(ref.path) ?? []), { remoteId: r.remoteId, uid: ref.uid, validity: ref.validity, messageIdHeader: r.messageIdHeader }]);
    }
    const parse = async (remoteId: string, source: Buffer) => {
      try {
        const { message } = await parseRaw(source, { remoteId });
        out.set(remoteId, { text: message.bodyText, html: message.bodyHtml, attachments: message.attachments });
      } catch (err) {
        console.warn(`[slipstream] imap ${remoteId}: couldn't read the message, ${err instanceof Error ? err.message : err}`);
      }
    };
    for (const [path, entries] of byPath) {
      for (let i = 0; i < entries.length; i += BODY_BATCH) {
        const chunk = entries.slice(i, i + BODY_BATCH);
        const sources = await this.run(async (c) => {
          try {
            return await withMailbox(c, path, true, async (mb) => {
              const live = chunk.filter((e) => e.validity === String(mb.uidValidity));
              const got = live.length ? await c.fetchAll(live.map((e) => e.uid), { uid: true, source: true }, { uid: true }) : [];
              return new Map(got.flatMap((fm) => (fm.source ? [[fm.uid, fm.source] as const] : [])));
            });
          } catch (err) {
            // A mailbox that is gone is the same as messages that moved out of it; anything else is a real failure.
            if ((err as { mailboxMissing?: boolean }).mailboxMissing) return new Map<number, Buffer>();
            throw err;
          }
        });
        for (const e of chunk) {
          const source = sources.get(e.uid);
          if (source) await parse(e.remoteId, source);
          else if (e.messageIdHeader) unmatched.push({ remoteId: e.remoteId, messageIdHeader: e.messageIdHeader });
        }
      }
    }
    if (unmatched.length) {
      await this.run(async (c) => {
        const targets = (await this.layout(c)).targets;
        for (const u of unmatched) {
          const source = await this.sourceByMessageId(c, targets, u.remoteId, u.messageIdHeader!);
          if (source) await parse(u.remoteId, source);
        }
      });
    }
    return out;
  }

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
