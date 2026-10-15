import { useEffect, useMemo, useRef } from "react";
import { AgentGlyph } from "../components/AgentGlyph.tsx";
import { EmptyState } from "../components/InboxZero.tsx";
import { Icon } from "../components/Icon.tsx";
import { Keys } from "../components/Keycap.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useNow } from "../lib/hooks.ts";
import { agoShort, longTime } from "../lib/format.ts";
import { openDraft } from "../store/compose.ts";
import { activityTick, decide, draftOf, loadDecided, markSeen, openRelated, refreshApprovals, review, setTab, threadOf, useAgentsExist, useReview, type ReviewTab } from "../store/agents.ts";
import { useStore } from "../store/createStore.ts";
import { navigate } from "../store/route.ts";
import type { Approval } from "../types.ts";

const FIELD = /^(To|Cc|Bcc|Subject|Send at):\s*(.*)$/;

/** Splits a send preview into its header fields and the message body; anything else is shown as plain text. */
export function parsePreview(text: string): { fields: { label: string; value: string }[]; body: string } {
  const lines = text.split("\n");
  const fields: { label: string; value: string }[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const m = FIELD.exec(lines[i]!);
    if (!m) break;
    const label = m[1]!;
    let value = m[2]!.trim();
    if (label === "Send at") {
      const when = new Date(value);
      if (!Number.isNaN(when.getTime())) value = longTime(when.getTime());
    }
    fields.push({ label, value });
  }
  const body = lines
    .slice(i)
    .map((l) => l.trimStart())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { fields, body };
}

export function ReviewView({ tab }: { tab: ReviewTab }) {
  const pending = useReview((s) => s.pending);
  const decided = useReview((s) => s.decided);
  const error = useReview((s) => s.error);
  const stored = useReview((s) => s.focusedId);
  const tick = useStore(activityTick, (s) => s.n);
  const hasAgents = useAgentsExist();
  const items = tab === "waiting" ? pending : decided;
  const effective = items?.find((a) => a.id === stored)?.id ?? items?.[0]?.id ?? null;
  const cards = useRef(new Map<string, HTMLLIElement>());
  const listRef = useRef<HTMLUListElement>(null);
  const prevFocus = useRef<string | null>(null);

  useEffect(() => setTab(tab), [tab]);
  useEffect(() => {
    markSeen();
    refreshApprovals(true);
  }, []);
  useEffect(() => {
    if (tab === "decided") void loadDecided();
  }, [tab, tick]);

  // The keyboard moved the focus (or a decision advanced it): bring the card into view and keep real focus on it.
  useEffect(() => {
    const before = prevFocus.current;
    prevFocus.current = effective;
    if (!before || !effective || before === effective) return;
    const el = cards.current.get(effective);
    if (!el) return;
    const active = document.activeElement;
    if (!active || active === document.body || listRef.current?.contains(active)) el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  }, [effective]);

  const waiting = pending?.length ?? 0;
  return (
    <section className="mail-pane" aria-label="Review">
      <PageHeader title="Review">
        <div className="seg" role="tablist" aria-label="Requests">
          <button id="rv-tab-waiting" role="tab" aria-selected={tab === "waiting"} aria-controls="rv-panel" className="seg-btn" onClick={() => navigate("/review")}>
            Waiting{waiting > 0 ? <span className="seg-count num"> {waiting}</span> : null}
          </button>
          <button id="rv-tab-decided" role="tab" aria-selected={tab === "decided"} aria-controls="rv-panel" className="seg-btn" onClick={() => navigate("/review?tab=decided")}>
            Decided
          </button>
        </div>
      </PageHeader>
      <div className="rv-scroll" id="rv-panel" role="tabpanel" aria-labelledby={`rv-tab-${tab}`}>
        <div className="sr-only" role="status" aria-live="polite">
          {tab === "waiting" && pending ? (waiting === 0 ? "Nothing waiting for you." : `${waiting} waiting for you`) : ""}
        </div>
        {items === null ? (
          error ? (
            <div className="state-block">
              <EmptyState title="Couldn't load your requests" hint={error} />
              <button className="btn" onClick={() => (tab === "waiting" ? refreshApprovals(true) : void loadDecided())}>
                Try again
              </button>
            </div>
          ) : (
            <div className="rv-skeleton" aria-busy="true" aria-label="Loading requests">
              <span />
              <span />
            </div>
          )
        ) : items.length === 0 ? (
          <div className="state-block">
            <EmptyState title={tab === "waiting" ? "Nothing waiting for you." : "Nothing decided yet."} />
            {tab === "waiting" && !hasAgents && (
              <button className="btn" onClick={() => navigate("/settings/connect")}>
                Connect an assistant
              </button>
            )}
          </div>
        ) : (
          <ul className="rv-list" role="list" aria-label={tab === "waiting" ? "Requests waiting for you" : "Past requests"} ref={listRef}>
            {items.map((a) => (
              <ReviewCard
                key={a.id}
                a={a}
                waiting={tab === "waiting"}
                focused={a.id === effective}
                register={(el) => (el ? cards.current.set(a.id, el) : cards.current.delete(a.id))}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const STATUS_LABEL: Record<string, string> = { approved: "Approved", rejected: "Rejected", failed: "Failed" };

function ReviewCard({ a, waiting, focused, register }: { a: Approval; waiting: boolean; focused: boolean; register: (el: HTMLLIElement | null) => void }) {
  const now = useNow();
  const { fields, body } = useMemo(() => parsePreview(a.preview), [a.preview]);
  const thread = threadOf(a);
  const draft = waiting ? draftOf(a) : undefined;
  const titleId = `rv-${a.id}`;
  const timeOf = waiting ? a.createdAt : (a.decidedAt ?? a.createdAt);

  return (
    <li
      ref={register}
      className={`rv-card ${focused ? "focused" : ""} ${waiting ? "" : "decided"}`}
      tabIndex={focused ? 0 : -1}
      aria-current={focused ? "true" : undefined}
      aria-labelledby={titleId}
      onFocus={() => review.get().focusedId !== a.id && review.set({ focusedId: a.id })}
      onMouseDown={() => review.get().focusedId !== a.id && review.set({ focusedId: a.id })}
    >
      <div className="rv-head">
        <AgentGlyph name={a.agent.name} size={32} />
        <div className="rv-who">
          <h2 className="rv-title" id={titleId}>
            {a.title}
          </h2>
          <div className="rv-reason">
            <span className="rv-agent">{a.agent.name}</span>
            <span aria-hidden="true"> · </span>
            {a.reason}
          </div>
        </div>
        <div className="rv-side">
          {!waiting && <span className={`rv-status rv-status-${a.status}`}>{STATUS_LABEL[a.status] ?? a.status}</span>}
          <time className="rv-time num" dateTime={new Date(timeOf).toISOString()} title={longTime(timeOf)}>
            {agoShort(timeOf, now)}
          </time>
        </div>
      </div>
      {a.status === "failed" && a.error && <div className="rv-error">{a.error}</div>}
      <div className="rv-preview" role="group" aria-label="What it wants to do" tabIndex={0}>
        {fields.length > 0 && (
          <dl className="rv-fields">
            {fields.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value || "None"}</dd>
              </div>
            ))}
          </dl>
        )}
        {body && <p className={`rv-body ${fields.length > 0 ? "has-fields" : ""}`}>{body}</p>}
      </div>
      {(waiting || thread) && (
        <div className="rv-actions">
          {waiting && (
            <>
              <button className="btn btn-primary" onClick={() => void decide(a, "approve")}>
                <Icon name="check" /> Approve <Keys binding="enter" />
              </button>
              <button className="btn" onClick={() => void decide(a, "reject")}>
                <Icon name="x" /> Reject <Keys binding="backspace" />
              </button>
            </>
          )}
          {draft && (
            <button className="btn btn-quiet rv-open" onClick={() => void openDraft(draft)}>
              Open draft
            </button>
          )}
          {thread && (
            <button className={`btn btn-quiet ${draft ? "" : "rv-open"}`} onClick={() => openRelated(a)}>
              Open conversation <Keys binding="e" />
            </button>
          )}
        </div>
      )}
    </li>
  );
}
