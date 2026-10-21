import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { patternWords } from "../../components/MoveMailDialog.tsx";
import { SplitForm, splitLibrary } from "../../components/SplitEditor.tsx";
import { ago, plural } from "../../lib/format.ts";
import { categoryName } from "../../lib/sorting.ts";
import { useCounts, refreshCounts } from "../../store/counts.ts";
import { reload } from "../../store/list.ts";
import { refreshSession, session, useSession } from "../../store/session.ts";
import { refreshSuggestions } from "../../store/suggestions.ts";
import { toast } from "../../store/toasts.ts";
import type { CategoryRule, Split } from "../../types.ts";
import { Switch } from "../autopilot/Switch.tsx";

/** Pull the tabs, counts and lists back in line with the server after a tab or a correction changed. */
async function refreshAfterChange() {
  await refreshSession();
  refreshCounts(true);
  void refreshSuggestions(true);
  reload(true);
}

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

  /** Show or hide a tab, or make it hide while empty: the switch moves at once and goes back if the server says no. */
  const change = async (s: Split, patch: { hidden?: boolean; hideWhenEmpty?: boolean }) => {
    const before = session.get().splits;
    session.set({ splits: before.map((x) => (x.id === s.id ? { ...x, ...patch } : x)) });
    try {
      await api.updateSplit(s.id, patch);
      refreshCounts(true);
    } catch (err) {
      session.set({ splits: before });
      toast.error(err instanceof Error ? err.message : "Couldn't change that split");
    }
  };

  const remove = async (s: Split) => {
    try {
      const res = await api.deleteSplit(s.id);
      await refreshAfterChange();
      const activityId = res.activityId;
      if (!activityId) {
        toast.info(`Removed ${s.name}`);
        return;
      }
      toast.undoable(`Removed ${s.name}`, () => {
        api.undoActivity(activityId).then(refreshAfterChange, (err: Error) => toast.error(err.message || "Couldn't undo that"));
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that split");
    }
  };

  const addLibrary = async (l: { name: string; query: string }) => {
    try {
      await api.createSplit(l.name, l.query);
      await refreshAfterChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add that split");
    }
  };

  return (
    <div className="settings-list">
      <section className="panel-block" aria-label="Your splits">
        <p className="block-lead">Splits sort your inbox into tabs. Drag to reorder, or use the arrows. Rename or hide the built-in tabs; the ones you make can be removed.</p>
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
                <SplitForm initial={s} lockQuery={s.builtin} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
              ) : (
                <>
                  <span className="grip" aria-hidden="true">
                    <Icon name="grip" />
                  </span>
                  <span className="split-main">
                    <span className="split-name">
                      {s.name} {s.builtin && <span className="chip">Built in</span>} {s.hidden && <span className="chip">Hidden</span>}
                    </span>
                    <code className="split-query">{s.query}</code>
                  </span>
                  <span className="split-count num">{counts?.splits[s.id] ? plural(counts.splits[s.id]!.total, "conversation") : ""}</span>
                  <span className="split-tools">
                    <button className="icon-btn" aria-label={`Move ${s.name} up`} disabled={i === 0} onClick={() => nudge(s.id, -1)}>
                      <Icon name="chevron-down" className="flip" />
                    </button>
                    <button className="icon-btn" aria-label={`Move ${s.name} down`} disabled={i === splits.length - 1} onClick={() => nudge(s.id, 1)}>
                      <Icon name="chevron-down" />
                    </button>
                    <button className="btn btn-sm" onClick={() => setEditing(s.id)} aria-label={`${s.builtin ? "Rename" : "Edit"} ${s.name}`}>
                      {s.builtin ? "Rename" : "Edit"}
                    </button>
                    {!s.builtin && (
                      <button className="btn btn-sm btn-danger" onClick={() => void remove(s)} aria-label={`Remove ${s.name}`}>
                        Remove
                      </button>
                    )}
                  </span>
                  <span className="split-opts">
                    <Switch label="Show as a tab" checked={!s.hidden} onChange={(on) => void change(s, { hidden: !on })} hint={s.builtin && s.hidden ? "Its mail isn't in any tab." : undefined} />
                    <Switch label="Hide when empty" checked={s.hideWhenEmpty} onChange={(on) => void change(s, { hideWhenEmpty: on })} />
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <Corrections />

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

/** The senders, companies and mailing lists whose mail you moved to another tab. Removing one sorts that mail by the usual rules again. */
function Corrections() {
  const [rules, setRules] = useState<CategoryRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api.categoryRules().then(setRules, (err: Error) => setError(err.message || "Couldn't load your corrections"));
  }, []);
  useEffect(load, [load]);

  const refresh = () => {
    load();
    refreshCounts(true);
    reload(true);
  };

  const remove = async (r: CategoryRule) => {
    setBusy(r.id);
    try {
      const res = await api.deleteCategoryRule(r.id);
      refresh();
      const text = `Stopped moving ${patternWords(r.pattern)} to ${categoryName(r.category)}`;
      const activityId = res.activityId;
      if (!activityId) toast.info(text);
      else
        toast.undoable(text, () => {
          api.undoActivity(activityId).then(refresh, (err: Error) => toast.error(err.message || "Couldn't undo that"));
        });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that correction");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel-block" aria-label="Sorting corrections">
      <h3 className="block-title">Sorting corrections</h3>
      <p className="block-lead">Mail from these senders, companies and mailing lists goes where you sent it. Press Shift+I on a conversation to add one.</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}{" "}
          <button className="link-btn" onClick={load}>
            Try again
          </button>
        </p>
      ) : rules === null ? (
        <div className="split-skeleton" aria-busy="true" aria-label="Loading corrections">
          <span className="skeleton-line" style={{ width: "60%" }} />
          <span className="skeleton-line" style={{ width: "44%" }} />
        </div>
      ) : rules.length === 0 ? (
        <div className="ag-empty">
          <div className="empty-title">No corrections yet</div>
          <div className="empty-hint">When a conversation is in the wrong tab, press Shift+I to move its sender's mail.</div>
        </div>
      ) : (
        <ul className="rule-list" role="list">
          {rules.map((r) => (
            <li key={r.id} className="rule-row">
              <span className="rule-main">
                <span className="rule-pattern ellipsis">{patternWords(r.pattern)}</span>
                <span className="rule-meta">
                  Goes to <strong>{categoryName(r.category)}</strong> · {ago(r.createdAt)}
                </span>
              </span>
              <button className="btn btn-sm" disabled={busy === r.id} onClick={() => void remove(r)} aria-label={`Stop moving ${patternWords(r.pattern)} to ${categoryName(r.category)}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
