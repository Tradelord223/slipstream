import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { domainOf, plural } from "../lib/format.ts";
import { matchText, useMatchCount } from "../lib/useMatchCount.ts";
import { refreshSession, session, useSession } from "../store/session.ts";
import { refreshCounts } from "../store/counts.ts";
import { acceptSuggestion, dismissSuggestion, refreshSuggestions, useSuggestions } from "../store/suggestions.ts";
import { toast } from "../store/toasts.ts";
import type { DescribeResult, Split } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";

export interface LibrarySplit {
  name: string;
  query: string;
  blurb: string;
}

/** Ready-made splits for what the built-in tabs don't cover. Updates, Promotions and Social are tabs already. */
export function splitLibrary(): LibrarySplit[] {
  const mine = session.get().accounts[0]?.email ?? session.get().user?.email ?? "";
  const domain = domainOf(mine);
  return [
    { name: "VIP", query: "is:vip", blurb: "People you starred as important" },
    { name: "Calendar", query: "filename:ics", blurb: "Invites and event updates" },
    ...(domain && domain !== "localhost" ? [{ name: "Team", query: `from:@${domain}`, blurb: `Anyone at ${domain}` }] : []),
    { name: "Needs reply", query: "is:unanswered", blurb: "Conversations you haven't answered" },
  ];
}

export function SplitForm({
  initial,
  seed,
  lockQuery = false,
  onDone,
  onCancel,
}: {
  initial?: Pick<Split, "id" | "name" | "query">;
  /** A new split that starts filled in, e.g. from a description. */
  seed?: { name: string; query: string };
  /** A built-in tab keeps its search; only its name changes. */
  lockQuery?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const start = initial ?? seed;
  const [name, setName] = useState(start?.name ?? "");
  const [query, setQuery] = useState(start?.query ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const match = useMatchCount(query, { inbox: true });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (initial) await api.updateSplit(initial.id, lockQuery ? { name: name.trim() } : { name: name.trim(), query: query.trim() });
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
        <input className="field" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="label:clients OR from:@kettlebyfreight.com" spellCheck={false} readOnly={lockQuery} />
      </label>
      <div className="form-hint" aria-live="polite">
        {match.state === "loading" ? "Counting…" : matchText(match)}
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

/** The splits worth making, counted from the last 30 days of the inbox. Loading, failing and having none are each said. */
function Suggestions() {
  const { status, items, error } = useSuggestions((s) => s);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void refreshSuggestions();
  }, []);

  if (status === "error") {
    return (
      <section className="add-section" aria-label="Suggested splits">
        <h4 className="add-title">Suggested for you</h4>
        <p className="form-hint" role="alert">
          {error ?? "Couldn't look for splits."}{" "}
          <button className="link-btn" onClick={() => void refreshSuggestions(true)}>
            Try again
          </button>
        </p>
      </section>
    );
  }
  if (status !== "ready") {
    return (
      <section className="add-section" aria-label="Suggested splits" aria-busy="true">
        <h4 className="add-title">Suggested for you</h4>
        <div className="library" aria-label="Looking for splits">
          <span className="library-skel" />
          <span className="library-skel" />
        </div>
      </section>
    );
  }
  if (items.length === 0) return null;
  return (
    <section className="add-section" aria-label="Suggested splits">
      <h4 className="add-title">Suggested for you</h4>
      <ul className="library" role="list">
        {items.map((s) => (
          <li key={s.key} className="suggested">
            <button
              className="library-item"
              disabled={busy === s.key}
              onClick={() => {
                setBusy(s.key);
                void acceptSuggestion(s).then((ok) => {
                  setBusy(null);
                  if (ok) void refreshSuggestions(true);
                });
              }}
            >
              <span className="library-main">
                <span className="library-name">{s.name}</span>
                <span className="library-blurb ellipsis">
                  {plural(s.count, "conversation")}
                  {s.senders.length > 0 && ` · ${s.senders.slice(0, 2).join(", ")}`}
                </span>
              </span>
              <span className="library-add">Add</span>
            </button>
            <button className="icon-btn" aria-label={`Don't suggest ${s.name}`} title="Not now" onClick={() => void dismissSuggestion(s)}>
              <Icon name="x" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Mail about my kids' school" becomes a search you can read and edit. Only offered when a model is connected. */
function DescribeBox({ onUse }: { onUse: (seed: { name: string; query: string }, result: Extract<DescribeResult, { available: true }>) => void }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "working" } | { kind: "error"; message: string }>({ kind: "idle" });
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);

  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    const description = text.trim();
    if (description.length < 3 || state.kind === "working") return;
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setState({ kind: "working" });
    try {
      const res = await api.describeSplit(description, c.signal);
      if (!res.available) {
        setState({ kind: "error", message: res.reason });
        return;
      }
      setState({ kind: "idle" });
      onUse({ name: description.replace(/^mail\s+(about|from)\s+/i, "").replace(/[.?!]+$/, "").slice(0, 60), query: res.query }, res);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState({ kind: "error", message: err instanceof Error ? err.message : "Couldn't turn that into a search" });
    }
  };

  const working = state.kind === "working";
  return (
    <form className="add-section describe" onSubmit={run}>
      <label className="add-title" htmlFor="describe-split">
        Describe it in words
      </label>
      <div className="describe-row">
        <input
          id="describe-split"
          className="field"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Mail about my kids' school"
          maxLength={300}
          autoComplete="off"
          disabled={working}
        />
        {working ? (
          <button type="button" className="btn" onClick={() => (ctl.current?.abort(), setState({ kind: "idle" }))}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn" disabled={text.trim().length < 3}>
            Find
          </button>
        )}
      </div>
      <div className="form-hint" aria-live="polite">
        {working ? "Writing the search…" : ""}
      </div>
      {state.kind === "error" && (
        <div className="form-error" role="alert">
          {state.message}
        </div>
      )}
    </form>
  );
}

/** Dialog behind the "+" tab: suggestions from your own mail, a description in words, the library, or write your own. */
export function AddSplitDialog({ onClose }: { onClose: () => void }) {
  const splits = useSession((s) => s.splits);
  const library = splitLibrary().filter((l) => !splits.some((s) => s.query === l.query));
  const [custom, setCustom] = useState<{ name: string; query: string } | boolean>(false);
  const [samples, setSamples] = useState<string[]>([]);
  const [canDescribe, setCanDescribe] = useState(false);

  useEffect(() => {
    let live = true;
    api.describeAvailable().then(
      (r) => live && setCanDescribe(r.available),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  const add = async (l: LibrarySplit) => {
    try {
      await api.createSplit(l.name, l.query);
      await refreshSession();
      refreshCounts(true);
      void refreshSuggestions(true);
      toast.info(`Added ${l.name}`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add that split");
    }
  };

  return (
    <Dialog label="Add a split" onClose={onClose} className="dialog-narrow add-dialog">
      <div className="dialog-head">
        <h3 aria-hidden="true">Add a split</h3>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="add-body">
        {custom ? (
          <>
            {samples.length > 0 && (
              <p className="add-samples">
                Includes <span className="ellipsis">{samples.slice(0, 3).join(" · ")}</span>
              </p>
            )}
            <SplitForm
              seed={typeof custom === "object" ? custom : undefined}
              onDone={() => (void refreshSuggestions(true), onClose())}
              onCancel={() => (setCustom(false), setSamples([]))}
            />
          </>
        ) : (
          <>
            <Suggestions />
            {canDescribe && (
              <DescribeBox
                onUse={(seed, result) => {
                  setSamples(result.samples);
                  setCustom(seed);
                }}
              />
            )}
            {library.length > 0 && (
              <section className="add-section" aria-label="Ready-made splits">
                <h4 className="add-title">Ready-made</h4>
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
              </section>
            )}
            <div className="form-actions">
              <button className="btn" onClick={() => setCustom(true)}>
                <Icon name="plus" />
                Write your own
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
