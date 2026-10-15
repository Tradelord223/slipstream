import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { EmptyState, InboxZero } from "../components/InboxZero.tsx";
import { MailHeader } from "../components/MailHeader.tsx";
import { ThreadList } from "../components/ThreadList.tsx";
import { clearFilter, reload, useList } from "../store/list.ts";
import { openDraft, useCompose } from "../store/compose.ts";
import { navigate, type MailView as MailViewType } from "../store/route.ts";
import { useSession } from "../store/session.ts";
import { listTime } from "../lib/format.ts";
import { htmlToText } from "../lib/format.ts";
import type { Draft } from "../types.ts";
import { Icon } from "../components/Icon.tsx";
import { formatWhen } from "../lib/when.ts";
import { useViewport } from "../lib/hooks.ts";

export function MailView({ view, compact = false }: { view: MailViewType; compact?: boolean }) {
  return (
    <section className={`mail-pane ${compact ? "mail-pane-compact" : ""}`} aria-label="Conversations">
      <MailHeader view={view} />
      {view.kind === "drafts" ? <DraftsList /> : <ListBody view={view} compact={compact} />}
    </section>
  );
}

function ListBody({ view, compact }: { view: MailViewType; compact: boolean }) {
  const status = useList((s) => s.status);
  const empty = useList((s) => s.visible.length === 0);
  const error = useList((s) => s.error);
  const filter = useList((s) => s.filter);
  const rowsLoaded = useList((s) => s.rows.length);
  const hasMore = useList((s) => Boolean(s.next));
  const noAccounts = useSession((s) => s.accounts.length === 0);
  const team = useSession((s) => s.mode === "team");

  if (status === "error" && rowsLoaded === 0) {
    return (
      <div className="state-block">
        <EmptyState title="Couldn't load your mail" hint={error ?? undefined} />
        <button className="btn" onClick={() => reload(true)}>
          Try again
        </button>
      </div>
    );
  }
  if (noAccounts && view.kind !== "search") {
    return (
      <div className="state-block">
        <EmptyState title="Connect your mail to get started" hint={`Add Gmail, Outlook or any mail server, or import an archive. ${team ? "Everything stays on your server." : "Everything stays on this machine."}`} />
        <button className="btn btn-primary" onClick={() => navigate("/settings/accounts")}>
          Add an account
        </button>
      </div>
    );
  }
  if (status === "loading" || status === "idle") return <ListSkeleton />;
  if (empty && !hasMore) {
    if (filter !== "all") {
      return (
        <div className="state-block">
          <EmptyState title={filter === "unread" ? "Nothing unread here" : "Nothing starred here"} />
          <button className="btn" onClick={clearFilter}>
            Show everything
          </button>
        </div>
      );
    }
    switch (view.kind) {
      case "inbox":
        return <InboxZero />;
      case "reminders":
        return <EmptyState title="No reminders" hint="Press H on a conversation and it comes back when you need it." />;
      case "done":
        return <EmptyState title="Nothing done yet" hint="Conversations you finish with E land here." />;
      case "sent":
        return <EmptyState title="No sent mail yet" />;
      case "starred":
        return <EmptyState title="Nothing starred" hint="Press S on a conversation to keep it close." />;
      case "label":
        return <EmptyState title={`Nothing labeled ${view.name}`} hint="Press L on a conversation to add the label." />;
      case "search":
        return <EmptyState title="No conversations match" hint="Try fewer words, or add in:all to search everywhere." />;
      default:
        return <EmptyState title="Nothing here" />;
    }
  }
  return <ThreadList compact={compact} />;
}

function ListSkeleton() {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading conversations">
      {Array.from({ length: 14 }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <span style={{ width: 120 + ((i * 37) % 60) }} />
          <span style={{ width: 220 + ((i * 53) % 220) }} />
        </div>
      ))}
    </div>
  );
}

function DraftsList() {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = useCompose((s) => s.open);
  const mobile = useViewport() === "mobile";

  useEffect(() => {
    let live = true;
    api
      .drafts()
      .then((r) => live && (setDrafts(r.drafts), setError(null)))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [open]);

  if (error) return <div className="state-block"><EmptyState title="Couldn't load drafts" hint={error} /></div>;
  if (!drafts) return <ListSkeleton />;
  if (drafts.length === 0) return <EmptyState title="No drafts" hint="Anything you start writing is saved here." />;
  return (
    <div className={`list-scroll ${mobile ? "two-line" : ""}`} role="list" aria-label="Drafts">
      {drafts.map((d) => {
        const to = d.to.map((a) => a.name || a.email).join(", ") || "No recipient";
        return (
          <button key={d.id} className="row draft-row" role="listitem" onClick={() => void openDraft(d.id)}>
            <span className="row-lead" />
            <span className="row-sender">
              <span className="ellipsis">{to}</span>
            </span>
            <span className="row-body">
              <span className="row-subject">{d.subject || "(no subject)"}</span>
              <span className="row-snippet"> — {htmlToText(d.bodyHtml).slice(0, 140)}</span>
            </span>
            <span className="row-meta">
              {d.status === "scheduled" && d.sendAt && (
                <span className="row-remind">
                  <Icon name="clock" size={13} />
                  {formatWhen(new Date(d.sendAt))}
                </span>
              )}
              {d.status === "failed" && <span className="chip chip-rose">Failed</span>}
            </span>
            <span className="row-time num">{listTime(d.updatedAt)}</span>
          </button>
        );
      })}
    </div>
  );
}
