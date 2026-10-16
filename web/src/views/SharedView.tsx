import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { AssistantButton } from "../components/AssistantButton.tsx";
import { EmptyState } from "../components/InboxZero.tsx";
import { Icon } from "../components/Icon.tsx";
import { MessageCard } from "../components/MessageCard.tsx";
import { useViewport } from "../lib/hooks.ts";
import { listTime, longTime, plural } from "../lib/format.ts";
import { openThread } from "../store/nav.ts";
import { useStore } from "../store/createStore.ts";
import { teamTick } from "../store/events.ts";
import { navigate } from "../store/route.ts";
import { useSession } from "../store/session.ts";
import { toast } from "../store/toasts.ts";
import { ui } from "../store/ui.ts";
import type { Message, SharedDetail, SharedSummary, TeamInfo } from "../types.ts";

export function SharedView({ id }: { id?: string }) {
  return id ? <SharedThread id={id} /> : <SharedList />;
}

function Header({ title, children }: { title: string; children?: React.ReactNode }) {
  const viewport = useViewport();
  return (
    <header className="mail-header">
      {viewport !== "desktop" && (
        <button className="icon-btn tap" aria-label="Open menu" onClick={() => ui.set({ sheetOpen: true })}>
          <Icon name="menu" size={18} />
        </button>
      )}
      <h1 className="view-title">{title}</h1>
      <span className="grow" />
      {children}
      <AssistantButton />
    </header>
  );
}

function SharedList() {
  const viewport = useViewport();
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [items, setItems] = useState<SharedSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tick = useStore(teamTick, (s) => s.n);

  useEffect(() => {
    let live = true;
    api
      .shared(status)
      .then((r) => live && (setItems(r.shared), setError(null)))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [status, tick]);

  return (
    <section className="mail-pane" aria-label="Shared conversations">
      <Header title="Shared">
        <div className="seg" role="tablist" aria-label="Status">
          {(["open", "resolved"] as const).map((s) => (
            <button key={s} role="tab" aria-selected={status === s} className="seg-btn" onClick={() => (setItems(null), setStatus(s))}>
              {s === "open" ? "Open" : "Resolved"}
            </button>
          ))}
        </div>
      </Header>
      {error ? (
        <EmptyState title="Couldn't load shared conversations" hint={error} />
      ) : !items ? (
        <div className="skeleton" aria-busy="true" />
      ) : items.length === 0 ? (
        <EmptyState title={status === "open" ? "Nothing shared yet" : "Nothing resolved yet"} hint={status === "open" ? "Open a conversation and choose Share with team." : undefined} />
      ) : (
        <div className={`list-scroll ${viewport === "mobile" ? "two-line" : ""}`} role="list">
          {items.map((s) => (
            <button key={s.id} className="row shared-row" role="listitem" onClick={() => navigate(`/shared/${s.id}`)}>
              <span className="row-lead" />
              <span className="row-sender">
                <span className="ellipsis">{s.sharedBy}</span>
              </span>
              <span className="row-body">
                <span className="row-subject">{s.subject}</span>
                <span className="row-snippet">
                  {s.lastComment ? (
                    <>
                      <span className="row-sep" aria-hidden="true">
                        {" — "}
                      </span>
                      {s.lastComment}
                    </>
                  ) : null}
                </span>
              </span>
              <span className="row-meta">
                {s.assignee && <span className="chip">{s.assignee.name}</span>}
                {s.commentCount > 0 && <span className="chip num">{plural(s.commentCount, "comment")}</span>}
              </span>
              <span className="row-time num">{listTime(s.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function SharedThread({ id }: { id: string }) {
  const [detail, setDetail] = useState<SharedDetail | null>(null);
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const accounts = useSession((s) => s.accounts);
  const tick = useStore(teamTick, (s) => s.n);

  const load = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([api.sharedThread(id), api.team()]);
      setDetail(d);
      setTeam(t);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't open this conversation");
    }
  }, [id]);
  useEffect(() => void load(), [load, tick]);

  const run = async (fn: () => Promise<unknown>, fail: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : fail);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <section className="thread-pane">
        <Header title="Shared" />
        <EmptyState title="Couldn't open this conversation" hint={error} />
      </section>
    );
  }
  if (!detail) return <section className="thread-pane"><Header title="Shared" /><div className="thread-skeleton" aria-busy="true"><span style={{ width: "50%" }} /><span style={{ width: "88%" }} /></div></section>;

  const messages: Message[] = detail.messages.map((m, i) => ({
    id: `shared-${i}`,
    from: m.from,
    to: m.to,
    cc: m.cc,
    bcc: [],
    replyTo: null,
    subject: m.subject,
    sentAt: m.sentAt,
    snippet: m.text.slice(0, 120),
    text: m.text,
    html: m.html,
    unread: false,
    outgoing: false,
    canUnsubscribe: false,
    isBulk: false,
    logoDomain: null,
    signals: [],
    attachments: [],
  }));

  return (
    <div className="thread-layout with-context">
      <section className="thread-pane" aria-label="Shared conversation">
        <header className="thread-bar">
          <button className="icon-btn tap" aria-label="Back to shared" onClick={() => navigate("/shared")}>
            <Icon name="chevron-left" size={18} />
          </button>
          <span className="thread-bar-subject ellipsis">{detail.subject}</span>
          <span className="grow" />
          {detail.ownThreadId && (
            <button className="btn btn-sm" onClick={() => openThread(detail.ownThreadId!)}>
              Open your copy
            </button>
          )}
          <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => api.updateShared(id, { status: detail.status === "open" ? "resolved" : "open" }), "Couldn't update this")}>
            <Icon name="check" /> {detail.status === "open" ? "Resolve" : "Reopen"}
          </button>
        </header>
        <div className="thread-scroll" data-thread-scroll>
          <div className="thread-inner">
            <h1 className="thread-subject">{detail.subject}</h1>
            {messages.map((m, i) => (
              <MessageCard key={m.id} message={m} expanded={i === messages.length - 1 || messages.length === 1} focused={false} accounts={accounts} onToggle={() => undefined} onReply={() => undefined} />
            ))}
          </div>
        </div>
      </section>
      <aside className="context" aria-label="Discussion">
        <section className="ctx-section">
          <h3>Owner</h3>
          <select
            className="select"
            aria-label="Assign to"
            value={detail.assigneeId ?? ""}
            onChange={(e) => void run(() => api.updateShared(id, { assigneeId: e.target.value || null }), "Couldn't assign this")}
          >
            <option value="">Unassigned</option>
            {team?.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </section>
        <section className="ctx-section">
          <h3>Comments</h3>
          {detail.comments.length === 0 && <p className="muted">No comments yet.</p>}
          <ul className="comments" role="list">
            {detail.comments.map((c) => (
              <li key={c.id}>
                <div className="comment-head">
                  <strong>{c.author.name}</strong>
                  <time className="muted num" title={longTime(c.createdAt)}>
                    {listTime(c.createdAt)}
                  </time>
                </div>
                <p>{c.body}</p>
              </li>
            ))}
          </ul>
          <form
            className="comment-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim()) return;
              void run(() => api.comment(id, text.trim()).then(() => setText("")), "Couldn't post that comment");
            }}
          >
            <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment" aria-label="Add a comment" />
            <button className="btn btn-sm btn-primary" disabled={busy || !text.trim()}>
              Post
            </button>
          </form>
        </section>
      </aside>
    </div>
  );
}
