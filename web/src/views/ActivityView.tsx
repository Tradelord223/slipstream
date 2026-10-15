import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { ActorGlyph } from "../components/AgentGlyph.tsx";
import { EmptyState } from "../components/InboxZero.tsx";
import { Icon } from "../components/Icon.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { agoShort, longTime } from "../lib/format.ts";
import { useNow } from "../lib/hooks.ts";
import { activityTick, undoActivity } from "../store/agents.ts";
import { useStore } from "../store/createStore.ts";
import { openThread } from "../store/nav.ts";
import { navigate, useRoute } from "../store/route.ts";
import type { ActivityItem, AgentInfo } from "../types.ts";

const PAGE = 100;
type Who = "all" | "you" | string;

export function ActivityView() {
  const tick = useStore(activityTick, (s) => s.n);
  const route = useRoute();
  const fromUrl = route.name === "activity" ? route.agentId : undefined;
  const [who, setWho] = useState<Who>(fromUrl ?? "all");
  const [limit, setLimit] = useState(PAGE);
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);

  // "View activity" on an assistant's conversation arrives as /activity?agent=<id>.
  useEffect(() => {
    if (!fromUrl) return;
    setItems(null);
    setLimit(PAGE);
    setWho(fromUrl);
  }, [fromUrl]);

  useEffect(() => {
    api
      .agents()
      .then((r) => setAgents(r.agents))
      .catch(() => setAgents([]));
  }, [tick]);

  const load = useCallback(
    (signal?: AbortSignal) =>
      api
        .activity({ limit, agentId: who !== "all" && who !== "you" ? who : undefined }, signal)
        .then((r) => {
          setItems(r.activity);
          setError(null);
        })
        .catch((err: Error) => {
          if (err.name !== "AbortError") setError(err.message);
        }),
    [limit, who],
  );
  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load, tick]);

  const choose = (next: Who) => {
    if (next === who) return;
    setItems(null);
    setLimit(PAGE);
    setWho(next);
  };

  const undo = async (a: ActivityItem) => {
    setUndoing(a.id);
    await undoActivity(a.id);
    setUndoing(null);
    void load();
  };

  const shown = items?.filter((a) => (who === "you" ? a.actor.kind === "human" : true)) ?? null;
  return (
    <section className="mail-pane" aria-label="Activity">
      <PageHeader title="Activity" />
      <div className="act-filters" role="group" aria-label="Show activity by">
        <Chip on={who === "all"} onClick={() => choose("all")}>
          Everyone
        </Chip>
        <Chip on={who === "you"} onClick={() => choose("you")}>
          You
        </Chip>
        {agents.map((g) => (
          <Chip key={g.id} on={who === g.id} onClick={() => choose(g.id)}>
            <span className="chip-glyph" aria-hidden="true">
              {g.name.trim().charAt(0).toUpperCase()}
            </span>
            {g.name}
          </Chip>
        ))}
      </div>
      <div className="act-scroll">
        {error && !items ? (
          <div className="state-block">
            <EmptyState title="Couldn't load activity" hint={error} />
            <button className="btn" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : !shown ? (
          <div className="rv-skeleton" aria-busy="true" aria-label="Loading activity">
            <span />
            <span />
            <span />
          </div>
        ) : shown.length === 0 ? (
          <div className="state-block">
            <EmptyState title="Nothing here yet" hint={who === "all" ? "What you and your assistants do shows up here." : undefined} />
          </div>
        ) : (
          <>
            <ul className="act-list" role="list" aria-label="Activity">
              {shown.map((a) => (
                <ActivityRow key={a.id} a={a} onUndo={() => void undo(a)} undoing={undoing === a.id} />
              ))}
            </ul>
            {items && items.length >= limit && limit < 500 && (
              <div className="act-more">
                <button className="btn" onClick={() => (setItems(null), setLimit((n) => n + PAGE))}>
                  Show more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button className="act-chip" aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

const STATUS: Record<string, string> = { done: "Done", pending: "Waiting for you", rejected: "Rejected", failed: "Failed", undone: "Undone" };

function ActivityRow({ a, onUndo, undoing }: { a: ActivityItem; onUndo: () => void; undoing: boolean }) {
  const now = useNow();
  const thread = a.threadIds?.[0];
  return (
    <li className={`act-row act-${a.status}`}>
      <ActorGlyph actor={a.actor} size={28} />
      <div className="act-main">
        <div className="act-summary">{a.summary}</div>
        <div className="act-meta">
          <span>{a.actor.name}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(a.createdAt).toISOString()} title={longTime(a.createdAt)} className="num">
            {agoShort(a.createdAt, now)}
          </time>
          {a.status !== "done" && (
            <>
              <span aria-hidden="true">·</span>
              <span className={`act-status act-status-${a.status}`}>{STATUS[a.status] ?? a.status}</span>
            </>
          )}
        </div>
        {a.status === "failed" && a.error && <div className="act-error">{a.error}</div>}
      </div>
      <div className="act-actions">
        {a.status === "pending" && (
          <button className="btn btn-sm" onClick={() => navigate("/review")}>
            Review
          </button>
        )}
        {thread && a.status !== "pending" && (
          <button className="btn btn-sm btn-quiet" onClick={() => openThread(thread)} aria-label={`Open the conversation: ${a.summary}`}>
            <Icon name="mail" /> Open
          </button>
        )}
        {a.canUndo && (
          <button className="btn btn-sm" disabled={undoing} onClick={onUndo} aria-label={`Undo: ${a.summary}`}>
            <Icon name="undo" /> Undo
          </button>
        )}
      </div>
    </li>
  );
}
