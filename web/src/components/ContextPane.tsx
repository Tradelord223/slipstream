import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { displayName, longTime, listTime, plural } from "../lib/format.ts";
import type { ContactInfo, SharedDetail, ThreadDetail } from "../types.ts";
import { teamTick } from "../store/events.ts";
import { openThread } from "../store/nav.ts";
import { loadThread } from "../store/threads.ts";
import { useSession } from "../store/session.ts";
import { toast } from "../store/toasts.ts";
import { Avatar } from "./Avatar.tsx";
import { Icon } from "./Icon.tsx";
import { useStore } from "../store/createStore.ts";

const contactCache = new Map<string, ContactInfo>();

function useContact(email: string | null) {
  const [info, setInfo] = useState<ContactInfo | null>(email ? (contactCache.get(email) ?? null) : null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!email) return;
    setInfo(contactCache.get(email) ?? null);
    setError(false);
    let live = true;
    api
      .contact(email)
      .then((c) => {
        contactCache.set(email, c);
        if (live) setInfo(c);
      })
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [email]);
  return { info, setInfo, error };
}

export function ContextPane({ detail }: { detail: ThreadDetail }) {
  const accounts = useSession((s) => s.accounts);
  const ai = useSession((s) => s.features.ai);
  const workspace = useSession((s) => s.workspace);
  const mine = new Set(accounts.map((a) => a.email.toLowerCase()));
  const other = [...detail.messages].reverse().find((m) => !mine.has(m.from.email.toLowerCase()))?.from ?? detail.messages[0]?.from;
  const { info, setInfo, error } = useContact(other?.email.toLowerCase() ?? null);

  const toggleVip = async () => {
    if (!info) return;
    const vip = !info.vip;
    setInfo({ ...info, vip });
    contactCache.set(info.email, { ...info, vip });
    try {
      await api.setVip(info.email, vip);
      toast.info(vip ? `${info.name || info.email} is a VIP` : "VIP removed");
    } catch (err) {
      setInfo(info);
      contactCache.set(info.email, info);
      toast.error(err instanceof Error ? err.message : "Couldn't update VIP");
    }
  };

  if (!other) return <aside className="context" aria-label="Contact" />;
  const total = info ? info.sent + info.received : 0;
  const recent = (info?.recent ?? []).filter((t) => t.id !== detail.thread.id).slice(0, 4);

  return (
    <aside className="context" aria-label="About this sender">
      <section className="ctx-card">
        <Avatar name={other.name} email={other.email} size={44} />
        <div className="ctx-who">
          <div className="ctx-name">{displayName(other)}</div>
          <div className="ctx-email">{other.email}</div>
        </div>
        <div className="ctx-meta">
          <div className="ctx-stats num">
            {info ? (
              total > 0 ? (
                <>
                  {plural(total, "email")}
                  {info.lastSeenAt ? ` · last on ${longDay(info.lastSeenAt)}` : ""}
                </>
              ) : (
                "No other emails yet"
              )
            ) : error ? (
              "Couldn't load history"
            ) : (
              <span className="skeleton-line" />
            )}
          </div>
          <button className={`vip ${info?.vip ? "on" : ""}`} aria-pressed={Boolean(info?.vip)} onClick={() => void toggleVip()} disabled={!info}>
            <Icon name="vip" size={14} />
            VIP
          </button>
        </div>
      </section>

      {ai && <SummaryCard threadId={detail.thread.id} />}

      {workspace && <TeamSection detail={detail} />}

      {recent.length > 0 && (
        <section className="ctx-section">
          <h3>Recent conversations</h3>
          <ul role="list" className="ctx-recent">
            {recent.map((t) => (
              <li key={t.id}>
                <button className="ctx-thread" onClick={() => openThread(t.id)}>
                  <span className="ctx-thread-subject ellipsis">{t.subject}</span>
                  <span className="ctx-thread-time num">{listTime(t.lastMessageAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const dayYearFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
function longDay(ms: number) {
  const d = new Date(ms);
  return d.getFullYear() === new Date().getFullYear() ? dayFmt.format(d) : dayYearFmt.format(d);
}

function TeamSection({ detail }: { detail: ThreadDetail }) {
  const tick = useStore(teamTick, (s) => s.n);
  const [shared, setShared] = useState<SharedDetail | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const sharedId = detail.sharedId;

  const refresh = useCallback(async () => {
    if (!sharedId) {
      setShared(null);
      return;
    }
    try {
      setShared(await api.sharedThread(sharedId));
    } catch {
      setShared(null);
    }
  }, [sharedId]);
  useEffect(() => void refresh(), [refresh, tick]);

  const share = async () => {
    setBusy(true);
    try {
      await api.shareThread(detail.thread.id);
      await loadThread(detail.thread.id);
      toast.info("Shared with your team");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't share this conversation");
    } finally {
      setBusy(false);
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sharedId || !text.trim()) return;
    setBusy(true);
    try {
      await api.comment(sharedId, text.trim());
      setText("");
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't post that comment");
    } finally {
      setBusy(false);
    }
  };

  if (!sharedId) {
    return (
      <section className="ctx-section">
        <h3>Team</h3>
        <p className="muted">Share this conversation to discuss it with your team.</p>
        <button className="btn btn-sm" onClick={() => void share()} disabled={busy}>
          <Icon name="users" /> Share with team
        </button>
      </section>
    );
  }
  return (
    <section className="ctx-section">
      <h3>Team comments</h3>
      {shared && shared.comments.length === 0 && <p className="muted">No comments yet.</p>}
      <ul className="comments" role="list">
        {shared?.comments.map((c) => (
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
      <form onSubmit={send} className="comment-form">
        <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment" aria-label="Add a comment" />
        <button className="btn btn-sm btn-primary" disabled={busy || !text.trim()}>
          Post
        </button>
      </form>
    </section>
  );
}

const summaries = new Map<string, string>();

/** Plain-text summary on request; never called until the button is pressed. */
function SummaryCard({ threadId }: { threadId: string }) {
  const [text, setText] = useState<string | null>(summaries.get(threadId) ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(summaries.get(threadId) ?? null);
    setError(null);
    setBusy(false);
  }, [threadId]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const { summary } = await api.summarize(threadId);
      summaries.set(threadId, summary);
      setText(summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't summarize this conversation");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ctx-section" data-ai-summary>
      <h3>Summary</h3>
      {text && <p className="summary-text">{text}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {busy ? (
        <span className="summary-busy" role="status">
          <span className="spinner" /> Reading the conversation…
        </span>
      ) : (
        <button className="btn btn-sm" onClick={() => void run()}>
          <Icon name="sparkle" /> {text ? "Summarize again" : "Summarize"}
        </button>
      )}
    </section>
  );
}
