import type { Account, Address } from "../types.ts";

const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const monthDayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const longFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Today: 3:41 PM. This year: Oct 12. Older: 10/12/25. */
export function listTime(ms: number, now = new Date()): string {
  const d = new Date(ms);
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  if (d.getFullYear() === now.getFullYear()) return monthDayFmt.format(d);
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
}

export function longTime(ms: number): string {
  return longFmt.format(new Date(ms));
}

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function firstName(a: Address | string): string {
  const name = typeof a === "string" ? a : a.name || a.email;
  const clean = name.replace(/["<>]/g, "").trim();
  if (clean.includes("@")) return clean.split("@")[0]!.split(/[._-]/)[0]!.replace(/^./, (c) => c.toUpperCase());
  return clean.split(/\s+/)[0] ?? clean;
}

export function displayName(a: Address): string {
  return a.name?.trim() || a.email;
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s.@_-]/gu, "").split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable avatar hue from an email address. */
export function avatarHue(email: string): number {
  return hash(email.toLowerCase()) % 360;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "Priya, Sam, me (3)". Names that belong to one of the user's accounts show as "me". */
export function senderLine(participants: Address[], accounts: Account[], count: number): string {
  const mine = new Set(accounts.map((a) => a.email.toLowerCase()));
  const names = participants.map((p) => (mine.has(p.email.toLowerCase()) ? "me" : firstName(p)));
  const unique = [...new Set(names)];
  const line = unique.slice(0, 3).join(", ") + (unique.length > 3 ? ` +${unique.length - 3}` : "");
  return count > 1 ? `${line || "me"} (${count})` : line || "me";
}

export function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}
