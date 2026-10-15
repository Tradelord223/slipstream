import { useState } from "react";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { SplitForm, splitLibrary } from "../../components/SplitEditor.tsx";
import { useCounts, refreshCounts } from "../../store/counts.ts";
import { refreshSession, session, useSession } from "../../store/session.ts";
import { toast } from "../../store/toasts.ts";
import type { Split } from "../../types.ts";

export function SplitsSettings() {
  const splits = useSession((s) => s.splits);
  const counts = useCounts();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const library = splitLibrary().filter((l) => !splits.some((s) => s.query === l.query));

  const reorder = async (from: string, to: string) => {
    if (from === to) return;
    const ids = splits.map((s) => s.id);
    ids.splice(ids.indexOf(from), 1);
    ids.splice(ids.indexOf(to), 0, from);
    const before = splits;
    session.set({ splits: ids.map((id) => splits.find((s) => s.id === id)!) });
    try {
      await api.orderSplits(ids);
    } catch (err) {
      session.set({ splits: before });
      toast.error(err instanceof Error ? err.message : "Couldn't reorder");
    }
  };
  const nudge = (id: string, dir: -1 | 1) => {
    const i = splits.findIndex((s) => s.id === id);
    const other = splits[i + dir];
    if (other) void reorder(id, other.id);
  };

  const remove = async (s: Split) => {
    try {
      await api.deleteSplit(s.id);
      await refreshSession();
      refreshCounts(true);
      toast.info(`Removed ${s.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that split");
    }
  };

  const addLibrary = async (l: { name: string; query: string }) => {
    try {
      await api.createSplit(l.name, l.query);
      await refreshSession();
      refreshCounts(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add that split");
    }
  };

  return (
    <div className="settings-list">
      <section className="panel-block" aria-label="Your splits">
        <p className="block-lead">Splits sort your inbox into tabs. Drag to reorder, or use the arrows.</p>
        <ul className="split-list" role="list">
          {splits.map((s, i) => (
            <li
              key={s.id}
              className={`split-row ${overId === s.id && dragId !== s.id ? "over" : ""}`}
              draggable={editing !== s.id}
              onDragStart={() => setDragId(s.id)}
              onDragOver={(e) => (e.preventDefault(), setOverId(s.id))}
              onDragEnd={() => (setDragId(null), setOverId(null))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) void reorder(dragId, s.id);
                setDragId(null);
                setOverId(null);
              }}
            >
              {editing === s.id ? (
                <SplitForm initial={s} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
              ) : (
                <>
                  <span className="grip" aria-hidden="true">
                    <Icon name="grip" />
                  </span>
                  <span className="split-main">
                    <span className="split-name">
                      {s.name} {s.builtin && <span className="chip">Built in</span>}
                    </span>
                    <code className="split-query">{s.query}</code>
                  </span>
                  <span className="split-count num">{counts?.splits[s.id] ? `${counts.splits[s.id]!.total} conversations` : ""}</span>
                  <span className="split-tools">
                    <button className="icon-btn" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => nudge(s.id, -1)}>
                      <Icon name="chevron-down" className="flip" />
                    </button>
                    <button className="icon-btn" aria-label={`Move ${s.name} down`} disabled={i === splits.length - 1} onClick={() => nudge(s.id, 1)}>
                      <Icon name="chevron-down" />
                    </button>
                    {!s.builtin && (
                      <>
                        <button className="btn btn-sm" onClick={() => setEditing(s.id)}>
                          Edit
                        </button>
                        <button className="btn btn-sm btn-danger" onClick={() => void remove(s)}>
                          Remove
                        </button>
                      </>
                    )}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      {library.length > 0 && (
        <section className="panel-block" aria-label="Split library">
          <h3 className="block-title">Add from the library</h3>
          <ul className="library" role="list">
            {library.map((l) => (
              <li key={l.name}>
                <button className="library-item" onClick={() => void addLibrary(l)}>
                  <span className="library-name">{l.name}</span>
                  <span className="library-blurb">{l.blurb}</span>
                  <code className="library-query">{l.query}</code>
                  <span className="library-add">Add</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel-block" aria-label="Custom split">
        <h3 className="block-title">Write your own</h3>
        {editing === "new" ? (
          <SplitForm onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
        ) : (
          <button className="btn" onClick={() => setEditing("new")}>
            <Icon name="plus" /> New split
          </button>
        )}
      </section>
    </div>
  );
}
