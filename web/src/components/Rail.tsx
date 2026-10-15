import { useRef, useState } from "react";
import { ago } from "../lib/format.ts";
import { useNow, useDismiss } from "../lib/hooks.ts";
import { Keys } from "./Keycap.tsx";
import { LabelTree } from "./labels/LabelTree.tsx";
import { Icon, Logo, type IconName } from "./Icon.tsx";
import { Link } from "./Link.tsx";
import { useReview } from "../store/agents.ts";
import { useCounts } from "../store/counts.ts";
import { useList } from "../store/list.ts";
import { navigate, useRoute, viewPath, type MailView } from "../store/route.ts";
import { setAccountFilter, signOut, useSession } from "../store/session.ts";
import { ui } from "../store/ui.ts";

interface NavItem {
  key: MailView["kind"] | "shared" | "review" | "activity" | "agent";
  label: string;
  icon: IconName;
  to: string;
  count?: number;
  /** An amber dot for something new that hasn't been looked at. */
  notice?: boolean;
}

export function Rail() {
  const route = useRoute();
  const listView = useList((s) => s.view);
  const counts = useCounts();
  const workspace = useSession((s) => s.workspace);
  const waiting = useReview((s) => s.pending?.length ?? 0);
  const unseen = useReview((s) => s.unseen);

  const activeView: MailView | null = route.name === "mail" ? route.view : route.name === "thread" ? listView : null;
  const items: NavItem[] = [
    { key: "inbox", label: "Inbox", icon: "inbox", to: "/", count: counts?.inbox.unread },
    { key: "reminders", label: "Reminders", icon: "clock", to: "/reminders", count: counts?.reminders },
    { key: "done", label: "Done", icon: "check-circle", to: "/done" },
    { key: "sent", label: "Sent", icon: "send", to: "/sent" },
    { key: "drafts", label: "Drafts", icon: "file", to: "/drafts" },
    { key: "starred", label: "Starred", icon: "star", to: "/starred" },
    ...(workspace ? [{ key: "shared" as const, label: "Shared", icon: "users" as IconName, to: "/shared" }] : []),
  ];
  const agentItems: NavItem[] = [
    { key: "agent", label: "Agent", icon: "sparkle", to: "/agent" },
    { key: "review", label: "Review", icon: "shield", to: "/review", count: waiting, notice: unseen },
    { key: "activity", label: "Activity", icon: "pulse", to: "/activity" },
  ];
  const isActive = (k: NavItem["key"]) =>
    k === "shared" ? route.name === "shared" : k === "review" ? route.name === "review" : k === "activity" ? route.name === "activity" : k === "agent" ? route.name === "agent" : activeView?.kind === k;
  const renderItem = (it: NavItem) => (
    <li key={it.key}>
      <Link
        to={it.to}
        className="nav-item"
        aria-current={isActive(it.key) ? "page" : undefined}
        aria-label={it.notice ? `${it.label}, new request` : undefined}
        onClick={() => ui.set({ sheetOpen: false })}
      >
        <span className="nav-icon">
          <Icon name={it.icon} />
          {it.notice && <span className="notice-dot" aria-hidden="true" />}
        </span>
        <span className="nav-label">{it.label}</span>
        {it.count ? <span className="nav-count num">{it.count}</span> : null}
      </Link>
    </li>
  );

  return (
    <nav className="rail" aria-label="Mailboxes">
      <div className="rail-top">
        <div className="brand">
          <Logo />
          <span>Slipstream</span>
        </div>
        <AccountSwitcher />
      </div>
      <ul className="nav" role="list">
        {items.map(renderItem)}
      </ul>
      <ul className="nav nav-agents" role="list" aria-label="Agents">
        {agentItems.map(renderItem)}
      </ul>
      <LabelTree />
      <div className="rail-foot">
        <Link to="/settings/general" className="nav-item" aria-current={route.name === "settings" ? "page" : undefined} onClick={() => ui.set({ sheetOpen: false })}>
          <Icon name="settings" />
          <span className="nav-label">Settings</span>
        </Link>
        <SyncStatus />
      </div>
    </nav>
  );
}

function AccountSwitcher() {
  const accounts = useSession((s) => s.accounts);
  const filter = useSession((s) => s.accountFilter);
  const mode = useSession((s) => s.mode);
  const user = useSession((s) => s.user);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const current = accounts.find((a) => a.id === filter);

  const choose = (id: string | null) => {
    setAccountFilter(id);
    setOpen(false);
  };

  return (
    <div className="switcher" ref={ref}>
      <button className="switcher-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {current ? <span className="dot" style={{ background: current.color }} /> : <StackedDots colors={accounts.map((a) => a.color)} />}
        <span className="switcher-name">{current ? current.email : "All inboxes"}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Accounts">
          <button className="menu-item" role="menuitemradio" aria-checked={!current} onClick={() => choose(null)}>
            <StackedDots colors={accounts.map((a) => a.color)} />
            <span className="grow">All inboxes</span>
            <Keys binding="ctrl+1" />
          </button>
          {accounts.map((a, i) => (
            <button key={a.id} className="menu-item" role="menuitemradio" aria-checked={current?.id === a.id} onClick={() => choose(a.id)}>
              <span className="dot" style={{ background: a.color }} />
              <span className="grow ellipsis">{a.email}</span>
              {i < 8 && <Keys binding={`ctrl+${i + 2}`} />}
            </button>
          ))}
          <div className="menu-sep" />
          <button className="menu-item" role="menuitem" onClick={() => { setOpen(false); navigate("/settings/accounts"); }}>
            <Icon name="plus" />
            <span className="grow">Add account</span>
          </button>
          {mode === "team" && (
            <>
              <div className="menu-sep" />
              <button className="menu-item" role="menuitem" onClick={() => void signOut()}>
                <Icon name="logout" />
                <span className="grow ellipsis">Sign out{user ? ` ${user.name.split(" ")[0]}` : ""}</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StackedDots({ colors }: { colors: string[] }) {
  return (
    <span className="dots" aria-hidden="true">
      {colors.slice(0, 3).map((c, i) => (
        <span key={i} className="dot" style={{ background: c }} />
      ))}
    </span>
  );
}

function SyncStatus() {
  const accounts = useSession((s) => s.accounts);
  const filter = useSession((s) => s.accountFilter);
  const now = useNow();
  const scoped = filter ? accounts.filter((a) => a.id === filter) : accounts;
  if (scoped.length === 0) return <div className="sync-line muted">No accounts yet</div>;
  const reauth = scoped.find((a) => a.syncStatus === "reauth");
  if (reauth) {
    return (
      <Link to="/settings/accounts" className="sync-line sync-warn">
        Reconnect {reauth.email}
      </Link>
    );
  }
  if (scoped.some((a) => a.syncStatus === "error")) return <div className="sync-line sync-warn" role="status">Sync hit a problem</div>;
  if (scoped.some((a) => a.syncStatus === "syncing")) return <div className="sync-line muted" role="status">Syncing…</div>;
  const last = Math.max(...scoped.map((a) => a.lastSyncedAt ?? 0));
  return (
    <div className="sync-line muted num" role="status">
      Synced {ago(last, now)}
    </div>
  );
}
