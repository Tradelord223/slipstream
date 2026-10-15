import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { sha256 } from "../lib/crypto.ts";
import { parseRaw } from "../mail/mime.ts";
import type { Folders, IncomingMessage } from "../mail/types.ts";

/** Attachments above this keep their metadata but not their bytes. */
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const LF = 0x0a;
const CR = 0x0d;
const GT = 0x3e;

/** Split a Google Takeout X-Gmail-Labels value: comma separated, entries with commas or spaces may be quoted. */
export function parseTakeoutLabels(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (quoted && ch === "\\" && i + 1 < value.length) {
      cur += value[++i];
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((l) => l.trim()).filter(Boolean);
}

interface TakeoutState {
  folders: Folders;
  unread: boolean;
  starred: boolean;
  labels: { remoteId: string; name: string }[];
}

/** Map Takeout's labels onto Slipstream's folders and flags. A message with no system label is archived. */
export function takeoutState(labels: string[]): TakeoutState {
  const state: TakeoutState = {
    folders: { inbox: false, sent: false, trash: false, spam: false },
    unread: false,
    starred: false,
    labels: [],
  };
  for (const name of labels) {
    switch (name.toLowerCase()) {
      case "inbox":
        state.folders.inbox = true;
        break;
      case "sent":
        state.folders.sent = true;
        break;
      case "trash":
        state.folders.trash = true;
        break;
      case "spam":
        state.folders.spam = true;
        break;
      case "unread":
        state.unread = true;
        break;
      case "starred":
        state.starred = true;
        break;
      case "opened":
      case "important":
        break;
      default:
        if (!/^category /i.test(name)) state.labels.push({ remoteId: `takeout:${name}`, name });
    }
  }
  return state;
}

const isBlank = (line: Buffer) => (line.length === 1 && line[0] === LF) || (line.length === 2 && line[0] === CR && line[1] === LF);

function startsWith(line: Buffer, prefix: string): boolean {
  return line.length >= prefix.length && line.toString("latin1", 0, prefix.length) === prefix;
}

/** mboxrd: ">From " at the start of a line is "From " with one level of quoting added. */
function unescapeFrom(line: Buffer): Buffer {
  if (line[0] !== GT) return line;
  let i = 0;
  while (line[i] === GT) i++;
  return startsWith(line.subarray(i), "From ") ? line.subarray(1) : line;
}

/**
 * Stream an mbox file one message at a time, holding only the current message in memory.
 * Works on raw bytes (not decoded text) so 8-bit bodies and CRLF line endings survive untouched.
 */
async function* splitMbox(path: string): AsyncGenerator<Buffer> {
  let message: Buffer[] = [];
  let first = true;
  let prevBlank = false;

  const finish = (): Buffer | undefined => {
    // The blank line before a separator belongs to the separator, not the message.
    if (message.length && isBlank(message[message.length - 1]!)) message.pop();
    const raw = message.length ? Buffer.concat(message) : undefined;
    message = [];
    return raw;
  };
  // Returns the previous message when `line` starts a new one.
  const feed = (line: Buffer): Buffer | undefined => {
    if (startsWith(line, "From ") && (first || prevBlank)) {
      const done = first ? undefined : finish();
      first = false;
      prevBlank = false;
      return done;
    }
    message.push(unescapeFrom(line));
    prevBlank = isBlank(line);
    return undefined;
  };

  let partial: Buffer[] = []; // a line that continues into the next chunk
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    let pos = 0;
    for (;;) {
      const nl = chunk.indexOf(LF, pos);
      if (nl < 0) {
        if (pos < chunk.length) partial.push(chunk.subarray(pos));
        break;
      }
      const line = partial.length ? Buffer.concat([...partial, chunk.subarray(pos, nl + 1)]) : chunk.subarray(pos, nl + 1);
      partial = [];
      pos = nl + 1;
      const done = feed(line);
      if (done) yield done;
    }
  }
  if (partial.length) {
    const done = feed(Buffer.concat(partial));
    if (done) yield done;
  }
  const last = finish();
  if (last) yield last;
}

interface ImportState {
  self?: string;
}

async function toMessage(raw: Buffer, state: ImportState): Promise<IncomingMessage> {
  const { message, header } = await parseRaw(raw, {
    remoteId: "import:pending",
    selfEmail: state.self,
    keepAttachmentContent: true,
  });
  const labelHeader = header("x-gmail-labels");
  if (labelHeader !== undefined) {
    const t = takeoutState(parseTakeoutLabels(labelHeader));
    message.folders = t.folders;
    message.unread = t.unread;
    message.starred = t.starred;
    message.labels = t.labels;
    // The first message labelled Sent tells us whose mailbox this is; it can't help the ones already yielded.
    if (t.folders.sent) {
      state.self ??= message.from.email;
      message.outgoing = true;
    }
  }
  const thread = header("x-gm-thrid");
  if (thread) message.remoteThreadId = thread.trim();
  message.remoteId = `import:${message.messageIdHeader ?? sha256(raw)}`;
  for (const a of message.attachments) if (a.content && a.content.length > MAX_ATTACHMENT_BYTES) a.content = undefined;
  return message;
}

async function startsLikeMbox(path: string): Promise<{ empty: boolean; mbox: boolean; head: string }> {
  const file = await open(path, "r");
  try {
    const buf = Buffer.alloc(2048);
    const { bytesRead } = await file.read(buf, 0, buf.length, 0);
    const head = buf.toString("latin1", 0, bytesRead);
    return { empty: bytesRead === 0, mbox: head.startsWith("From "), head };
  } finally {
    await file.close();
  }
}

/**
 * Read messages from an .eml file (one message) or an mbox (detected by its leading "From " line, whatever the
 * extension), including Google Takeout exports. `selfEmail` marks which messages are outgoing; if omitted it is
 * learned from the first message Takeout labels Sent.
 */
export async function* readMailFile(path: string, filename: string, selfEmail?: string): AsyncGenerator<IncomingMessage> {
  const state: ImportState = { self: selfEmail?.toLowerCase() };
  const probe = await startsLikeMbox(path);
  if (probe.empty) throw new Error(`${filename} is empty`);
  if (probe.mbox) {
    for await (const raw of splitMbox(path)) yield await toMessage(raw, state);
    return;
  }
  if (!/^[\x21-\x39\x3b-\x7e]+:/m.test(probe.head)) {
    throw new Error(`${filename} doesn't look like an email (.eml) or a mailbox (.mbox) file`);
  }
  yield await toMessage(await readFile(path), state);
}
