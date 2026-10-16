/**
 * Just enough MIME for the IMAP stand-ins to answer BODYSTRUCTURE, HEADER.FIELDS and partial part fetches from a
 * message's raw bytes, so tests can show that a first sync asks for those and never for the whole message.
 */
import type { MessageStructureObject } from "imapflow";

export interface MimeNode {
  /** Every header in its original case and order. */
  all: [string, string][];
  headers: Map<string, string>;
  body: Buffer;
  children?: MimeNode[];
}

function split(raw: Buffer): { head: string; body: Buffer } {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { head: raw.toString("latin1", 0, crlf), body: raw.subarray(crlf + 4) };
  if (lf >= 0) return { head: raw.toString("latin1", 0, lf), body: raw.subarray(lf + 2) };
  return { head: raw.toString("latin1"), body: Buffer.alloc(0) };
}

function unfold(head: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) out[out.length - 1]![1] += ` ${line.trim()}`;
    else {
      const i = line.indexOf(":");
      if (i > 0) out.push([line.slice(0, i), line.slice(i + 1).trim()]);
    }
  }
  return out;
}

function params(value: string | undefined): { value: string; params: Record<string, string> } {
  const [first = "", ...rest] = (value ?? "").split(";");
  const out: Record<string, string> = {};
  for (const part of rest) {
    const m = /^\s*([^=\s]+)\s*=\s*(?:"([^"]*)"|(.*?))\s*$/.exec(part);
    if (m) out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  return { value: first.trim().toLowerCase(), params: out };
}

export function parseMime(raw: Buffer): MimeNode {
  const { head, body } = split(raw);
  const headers = new Map<string, string>();
  const all = unfold(head);
  for (const [k, v] of all) if (!headers.has(k.toLowerCase())) headers.set(k.toLowerCase(), v);
  const type = params(headers.get("content-type"));
  const node: MimeNode = { all, headers, body };
  if (type.value.startsWith("multipart/") && type.params.boundary) {
    const delimiter = `--${type.params.boundary}`;
    node.children = [];
    for (const segment of body.toString("latin1").split(delimiter).slice(1)) {
      if (segment.startsWith("--")) break;
      const part = segment.replace(/^[ \t]*\r?\n/, "").replace(/\r?\n$/, "");
      node.children.push(parseMime(Buffer.from(part, "latin1")));
    }
  }
  return node;
}

/** The requested header lines only, as HEADER.FIELDS returns them (original case and order, then a blank line). */
export function headerBlock(raw: Buffer, names: string[]): Buffer {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const lines = unfold(split(raw).head)
    .filter(([k]) => wanted.has(k.toLowerCase()))
    .map(([k, v]) => `${k}: ${v}\r\n`);
  return Buffer.from(`${lines.join("")}\r\n`, "latin1");
}

function describe(node: MimeNode, path: number[]): MessageStructureObject {
  const type = params(node.headers.get("content-type") ?? "text/plain; charset=us-ascii");
  const out: MessageStructureObject = { type: type.value };
  if (path.length) out.part = path.join(".");
  if (Object.keys(type.params).length) out.parameters = type.params;
  if (node.children) {
    out.childNodes = node.children.map((c, i) => describe(c, [...path, i + 1]));
    return out;
  }
  const id = node.headers.get("content-id");
  if (id) out.id = id;
  out.encoding = (node.headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
  out.size = node.body.length;
  if (type.value.startsWith("text/")) out.lineCount = node.body.toString("latin1").split("\n").length;
  const disposition = node.headers.get("content-disposition");
  if (disposition) {
    const d = params(disposition);
    out.disposition = d.value;
    if (Object.keys(d.params).length) out.dispositionParameters = d.params;
  }
  return out;
}

export function structureOf(raw: Buffer): MessageStructureObject {
  return describe(parseMime(raw), []);
}

/** The bytes of one part by IMAP part number ("1", "2.1"); a single-part message is part 1. */
export function partBytes(raw: Buffer, key: string): Buffer | undefined {
  let node = parseMime(raw);
  const path = key.split(".").map(Number);
  if (!node.children) return path.length === 1 && path[0] === 1 ? node.body : undefined;
  for (const n of path) {
    const next = node.children?.[n - 1];
    if (!next) return undefined;
    node = next;
  }
  return node.body;
}

const q = (s: string) => `"${s.replace(/["\\]/g, "\\$&")}"`;
const list = (o: Record<string, string> | undefined) =>
  o && Object.keys(o).length ? `(${Object.entries(o).map(([k, v]) => `${q(k.toUpperCase())} ${q(v)}`).join(" ")})` : "NIL";

/** A structure as the BODYSTRUCTURE response writes it. */
export function structureWire(n: MessageStructureObject): string {
  const [major = "text", minor = "plain"] = n.type.split("/");
  if (n.childNodes) return `(${n.childNodes.map(structureWire).join("")} ${q(minor.toUpperCase())} ${list(n.parameters)} NIL NIL NIL)`;
  const disposition = n.disposition ? `(${q(n.disposition.toUpperCase())} ${list(n.dispositionParameters)})` : "NIL";
  return [
    "(",
    `${q(major.toUpperCase())} ${q(minor.toUpperCase())} ${list(n.parameters)} ${n.id ? q(n.id) : "NIL"} NIL ${q((n.encoding ?? "7bit").toUpperCase())} ${n.size ?? 0}`,
    major === "text" ? ` ${n.lineCount ?? 0}` : "",
    ` NIL ${disposition} NIL NIL)`,
  ].join("");
}
