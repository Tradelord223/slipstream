import { api, ApiError } from "../api.ts";
import type { Account, Features, Settings, Snippet, Split, User, Workspace } from "../types.ts";
import { createStore, useStore } from "./createStore.ts";
import { getRoute, navigate } from "./route.ts";
import { toast } from "./toasts.ts";

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  density: "comfortable",
  remoteImages: "ask",
  autoAdvance: "next",
  signature: "",
  keymap: {},
  instantIntro: "Thanks {first_name}! Moving you to bcc.",
  defaultRemindHour: 8,
  showTips: true,
  unifiedInbox: true,
  assistant: "off",
  senderLogos: false,
  helpers: { codes: true, deliveries: "latest", securityAlerts: true, urgent: true },
};

export interface Session {
  status: "loading" | "ready" | "signin" | "setup" | "error";
  error: string | null;
  mode: "local" | "team";
  user: User | null;
  workspace: Workspace | null;
  accounts: Account[];
  splits: Split[];
  labels: string[];
  settings: Settings;
  features: Features;
  snippets: Snippet[];
  /** Account id to limit the mailbox to, or null for everything. */
  accountFilter: string | null;
}

const savedFilter = (() => {
  try {
    return localStorage.getItem("ss-account");
  } catch {
    return null;
  }
})();

export const session = createStore<Session>({
  status: "loading",
  error: null,
  mode: "local",
  user: null,
  workspace: null,
  accounts: [],
  splits: [],
  labels: [],
  settings: DEFAULT_SETTINGS,
  features: { ai: false, google: false, microsoft: false, undoSendSeconds: 10 },
  snippets: [],
  accountFilter: savedFilter || null,
});

export const useSession = <S,>(selector: (s: Session) => S) => useStore(session, selector);

export function applyTheme(theme: Settings["theme"]) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("ss-theme", theme);
  } catch {
    /* private mode */
  }
}

export async function loadSession(): Promise<void> {
  try {
    const b = await api.bootstrap();
    const settings = { ...DEFAULT_SETTINGS, ...b.settings };
    const filter = session.get().accountFilter;
    session.set({
      status: "ready",
      error: null,
      mode: b.mode,
      user: b.user,
      workspace: b.workspace,
      accounts: b.accounts,
      splits: b.splits,
      labels: b.labels,
      settings,
      features: b.features,
      accountFilter: filter && b.accounts.some((a) => a.id === filter) ? filter : null,
    });
    applyTheme(settings.theme);
    void loadSnippets();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      try {
        const s = await api.authState();
        session.set({ status: s.needsSetup ? "setup" : "signin", mode: "team", error: null });
      } catch {
        session.set({ status: "signin", mode: "team" });
      }
      return;
    }
    session.set({ status: "error", error: err instanceof Error ? err.message : "Something went wrong" });
  }
}

/** Refresh accounts, splits, labels and workspace without resetting the rest of the session. */
export async function refreshSession(): Promise<void> {
  try {
    const b = await api.bootstrap();
    const filter = session.get().accountFilter;
    session.set({
      workspace: b.workspace,
      accounts: b.accounts,
      splits: b.splits,
      labels: b.labels,
      features: b.features,
      settings: { ...DEFAULT_SETTINGS, ...b.settings },
      accountFilter: filter && b.accounts.some((a) => a.id === filter) ? filter : null,
    });
  } catch {
    /* the next event retries */
  }
}

export async function loadSnippets(): Promise<void> {
  try {
    session.set({ snippets: (await api.snippets()).snippets });
  } catch {
    /* snippets are optional */
  }
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const before = session.get().settings;
  const next = { ...before, ...patch };
  session.set({ settings: next });
  if (patch.theme) applyTheme(patch.theme);
  try {
    await api.saveSettings(patch);
  } catch (err) {
    session.set({ settings: before });
    if (patch.theme) applyTheme(before.theme);
    toast.error(err instanceof Error ? err.message : "Couldn't save that setting");
  }
}

const viewKey = (account: string | null) => `ss-view:${account ?? "all"}`;

/** Remember the mailbox each account was last looking at. */
export function rememberView(path: string) {
  try {
    localStorage.setItem(viewKey(session.get().accountFilter), path);
  } catch {
    /* ignore */
  }
}

export function setAccountFilter(id: string | null) {
  session.set({ accountFilter: id });
  try {
    if (id) localStorage.setItem("ss-account", id);
    else localStorage.removeItem("ss-account");
  } catch {
    /* ignore */
  }
  // Each account comes back to the mailbox it was last in.
  const name = getRoute().name;
  if (name === "mail" || name === "thread" || name === "settings") {
    let path: string | null = null;
    try {
      path = localStorage.getItem(viewKey(id));
    } catch {
      /* ignore */
    }
    navigate(path && path.startsWith("/") && !path.startsWith("/t/") ? path : "/");
  }
}

export function accountById(id: string): Account | undefined {
  return session.get().accounts.find((a) => a.id === id);
}

export function myEmails(): Set<string> {
  return new Set(session.get().accounts.map((a) => a.email.toLowerCase()));
}

export async function signOut(): Promise<void> {
  try {
    await api.logout();
  } catch {
    /* the cookie is cleared server-side on success; either way we leave */
  }
  session.set({ status: "signin", user: null, workspace: null, accounts: [], splits: [], labels: [], snippets: [] });
  navigate("/login", { replace: true });
}
