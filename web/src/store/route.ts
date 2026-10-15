import { useMemo } from "react";
import { createStore, useStore } from "./createStore.ts";

/** Which mailbox the list shows. */
export type MailView =
  | { kind: "inbox"; splitId?: string }
  | { kind: "reminders" }
  | { kind: "done" }
  | { kind: "sent" }
  | { kind: "drafts" }
  | { kind: "starred" }
  | { kind: "label"; name: string }
  | { kind: "search"; q: string };

export type Route =
  | { name: "mail"; view: MailView }
  | { name: "thread"; id: string }
  | { name: "shared"; id?: string }
  | { name: "settings"; section: string }
  | { name: "login" }
  | { name: "setup" }
  | { name: "join"; invite: string };

interface Loc {
  path: string;
  search: string;
  /** The mailbox URL the user came from, so Esc from a conversation goes back to it. */
  from: string | null;
}

const read = (): Loc => ({
  path: location.pathname,
  search: location.search,
  from: (history.state as { from?: string } | null)?.from ?? null,
});

const loc = createStore<Loc>(read());
window.addEventListener("popstate", () => loc.set(read()));

export function navigate(to: string, opts: { replace?: boolean; from?: string | null } = {}) {
  const current = location.pathname + location.search;
  if (to === current && !opts.replace) return;
  const state = opts.from ? { from: opts.from } : null;
  if (opts.replace) history.replaceState(state, "", to);
  else history.pushState(state, "", to);
  loc.set(read());
}

export function currentUrl(): string {
  return location.pathname + location.search;
}

export function parseRoute(path: string, search: string): Route {
  const seg = path.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  const q = new URLSearchParams(search);
  switch (seg[0]) {
    case undefined:
    case "inbox":
      return { name: "mail", view: { kind: "inbox" } };
    case "split":
      return { name: "mail", view: { kind: "inbox", splitId: seg[1] } };
    case "reminders": return { name: "mail", view: { kind: "reminders" } };
    case "done": return { name: "mail", view: { kind: "done" } };
    case "sent": return { name: "mail", view: { kind: "sent" } };
    case "drafts": return { name: "mail", view: { kind: "drafts" } };
    case "starred": return { name: "mail", view: { kind: "starred" } };
    case "label": return { name: "mail", view: { kind: "label", name: seg[1] ?? "" } };
    case "search": return { name: "mail", view: { kind: "search", q: q.get("q") ?? "" } };
    case "t": return seg[1] ? { name: "thread", id: seg[1] } : { name: "mail", view: { kind: "inbox" } };
    case "shared": return { name: "shared", id: seg[1] };
    case "settings": return { name: "settings", section: seg[1] ?? "general" };
    case "login": return { name: "login" };
    case "setup": return { name: "setup" };
    case "join": return { name: "join", invite: q.get("invite") ?? "" };
    default: return { name: "mail", view: { kind: "inbox" } };
  }
}

export function viewPath(v: MailView): string {
  switch (v.kind) {
    case "inbox": return v.splitId ? `/split/${encodeURIComponent(v.splitId)}` : "/";
    case "reminders": return "/reminders";
    case "done": return "/done";
    case "sent": return "/sent";
    case "drafts": return "/drafts";
    case "starred": return "/starred";
    case "label": return `/label/${encodeURIComponent(v.name)}`;
    case "search": return `/search?q=${encodeURIComponent(v.q)}`;
  }
}

export function useLocation() {
  const path = useStore(loc, (s) => s.path);
  const search = useStore(loc, (s) => s.search);
  const from = useStore(loc, (s) => s.from);
  return { path, search, from };
}

export function useRoute(): Route {
  const { path, search } = useLocation();
  return useMemo(() => parseRoute(path, search), [path, search]);
}

export function getRoute(): Route {
  return parseRoute(location.pathname, location.search);
}

export function routeFrom(): string | null {
  return loc.get().from;
}

export function viewKey(v: MailView): string {
  return JSON.stringify(v);
}
