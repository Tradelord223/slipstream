import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { domainOf, plural } from "../lib/format.ts";
import { refreshSession, session, useSession } from "../store/session.ts";
import { refreshCounts } from "../store/counts.ts";
import { toast } from "../store/toasts.ts";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";

export interface LibrarySplit {
  name: string;
  query: string;
  blurb: string;
}

export function splitLibrary(): LibrarySplit[] {
  const mine = session.get().accounts[0]?.email ?? session.get().user?.email ?? "";
  const domain = domainOf(mine);
  return [
    { name: "VIP", query: "is:vip", blurb: "People you starred as important" },
    { name: "News", query: "category:news", blurb: "Newsletters and digests" },
    { name: "Notifications", query: "category:notification", blurb: "Receipts, alerts and automated mail" },
    { name: "Calendar", query: "subject:invitation", blurb: "Invites and event updates" },
    ...(domain && domain !== "localhost" ? [{ name: "Team", query: `from:@${domain}`, blurb: `Anyone at ${domain}` }] : []),
    { name: "Needs reply", query: "is:unanswered", blurb: "Conversations you haven't answered" },
  ];
}

/** "N conversations" for a split query, counted in the inbox the way the split itself would. */
export function useMatchCount(query: string): { text: string; loading: boolean } {
  const [state, setState] = useState<{ text: string; loading: boolean }>({ text: "", loading: false });
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setState({ text: "", loading: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const page = await api.threads({ view: "search", q: /\bin:/.test(q) ? q : `in:inbox ${q}`, limit: 500 }, ctl.signal);
        const n = page.threads.length;
        setState({ text: page.next ? "500+ conversations" : plural(n, "conversation"), loading: false });
      } catch (err) {
        if ((err as Error).name !== "AbortError") setState({ text: "", loading: false });
      }
    }, 280);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query]);
  return state;
}

export function SplitForm({
  initial,
  onDone,
  onCancel,
}: {
  initial?: { id: string; name: string; query: string };
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [query, setQuery] = useState(initial?.query ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const match = useMatchCount(query);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (initial) await api.updateSplit(initial.id, name.trim(), query.trim());
      else await api.createSplit(name.trim(), query.trim());
      await refreshSession();
      refreshCounts(true);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that split");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="split-form" onSubmit={save}>
      <label className="form-row">
        <span>Name</span>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Clients" autoFocus />
      </label>
      <label className="form-row">
        <span>Search</span>
        <input className="field" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="label:clients OR from:@kettlebyfreight.com" spellCheck={false} />
      </label>
      <div className="form-hint" aria-live="polite">
        {match.loading ? "Counting…" : match.text}
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-actions">
        {onCancel && (
          <button type="button" className="btn btn-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !query.trim()}>
          {initial ? "Save split" : "Add split"}
        </button>
      </div>
    </form>
  );
}

/** Dialog behind the "+" tab: pick from the library or write your own. */
export function AddSplitDialog({ onClose }: { onClose: () => void }) {
  const splits = useSession((s) => s.splits);
  const library = splitLibrary().filter((l) => !splits.some((s) => s.query === l.query));
  const [custom, setCustom] = useState(false);

  const add = async (l: LibrarySplit) => {
    try {
      await api.createSplit(l.name, l.query);
      await refreshSession();
      refreshCounts(true);
      toast.info(`Added ${l.name}`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add that split");
    }
  };

  return (
    <Dialog label="Add a split" onClose={onClose} className="dialog-narrow">
      <div className="dialog-head">
        <h3>Add a split</h3>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {custom ? (
        <SplitForm onDone={onClose} onCancel={() => setCustom(false)} />
      ) : (
        <>
          <ul className="library" role="list">
            {library.map((l) => (
              <li key={l.name}>
                <button className="library-item" onClick={() => void add(l)}>
                  <span className="library-name">{l.name}</span>
                  <span className="library-blurb">{l.blurb}</span>
                  <span className="library-add">Add</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="form-actions">
            <button className="btn" onClick={() => setCustom(true)}>
              <Icon name="plus" />
              Write your own
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
