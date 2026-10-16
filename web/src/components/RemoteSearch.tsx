import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { joinNames, providerName, searchesAtProvider, sendsToProvider } from "../lib/remoteSearch.ts";
import { addRemote, clearRemote } from "../store/list.ts";
import { useSession } from "../store/session.ts";
import type { Account } from "../types.ts";

/** The pause after the last keystroke before a search leaves the machine. */
const DEBOUNCE_MS = 350;

interface Progress {
  status: "searching" | "done" | "error";
  /** More results are waiting at the provider. */
  next: string | null;
  /** The page that was asked for, so Try again asks for the same one. */
  asked: string | null;
}

/**
 * Searches a person's whole mailbox at each account's provider while local results are already on screen. Each account is
 * asked on its own, so a quick one lands while a slow one is still working, and one that fails doesn't hold up the rest.
 * Finds go into the list store (merged, newest first, one row per conversation); this returns the quiet line that goes
 * after the last row: what is happening, what went wrong, or "Show more".
 */
export function useRemoteSearch(q: string | null): { line: ReactNode | null; busy: boolean } {
  const accounts = useSession((s) => s.accounts);
  const filter = useSession((s) => s.accountFilter);
  const targets = useMemo(
    () => accounts.filter((a) => searchesAtProvider(a) && (!filter || a.id === filter)),
    [accounts, filter],
  );
  const targetKey = targets.map((a) => a.id).join(",");
  const active = Boolean(q) && sendsToProvider(q!) && targets.length > 0;

  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const live = useRef<AbortController | null>(null);

  const ask = useCallback(
    async (account: Account, query: string, token: string | null, signal: AbortSignal) => {
      setProgress((p) => ({ ...p, [account.id]: { status: "searching", next: null, asked: token } }));
      try {
        const page = await api.searchRemote({ q: query, account: account.id, pageToken: token }, signal);
        if (signal.aborted) return;
        addRemote(page.threads);
        const failed = page.failures.some((f) => f.accountId === account.id);
        setProgress((p) => ({ ...p, [account.id]: { status: failed ? "error" : "done", next: failed ? null : page.next, asked: token } }));
      } catch (err) {
        if (signal.aborted || (err as Error).name === "AbortError") return;
        setProgress((p) => ({ ...p, [account.id]: { status: "error", next: null, asked: token } }));
      }
    },
    [],
  );

  useEffect(() => {
    clearRemote();
    if (!active) {
      setProgress({});
      return;
    }
    const controller = new AbortController();
    live.current = controller;
    // Marked as searching from the start, so the list doesn't announce "no matches" in the pause before the request.
    setProgress(Object.fromEntries(targets.map((a) => [a.id, { status: "searching", next: null, asked: null } satisfies Progress])));
    const timer = setTimeout(() => {
      for (const a of targets) void ask(a, q!, null, controller.signal);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
      clearRemote();
    };
    // `targets` is covered by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, active, targetKey, ask]);

  if (!active) return { line: null, busy: false };

  const states = targets.map((a) => ({ account: a, state: progress[a.id] }));
  const searching = states.filter((s) => s.state?.status === "searching");
  const failed = states.filter((s) => s.state?.status === "error");
  const more = states.filter((s) => s.state?.status === "done" && s.state.next);
  const signal = () => live.current?.signal ?? new AbortController().signal;

  if (searching.length > 0) {
    const continuing = searching.every((s) => s.state!.asked !== null);
    return {
      busy: true,
      line: <span className="remote-text">{`Searching ${continuing ? "more of" : "all"} your mail at ${joinNames(searching.map((s) => providerName(s.account)))}…`}</span>,
    };
  }
  if (failed.length === 0 && more.length === 0) return { line: null, busy: false };
  return {
    busy: false,
    line: (
      <>
        {failed.length > 0 && (
          <>
            <span className="remote-text">{`Couldn't search ${joinNames(failed.map((s) => providerName(s.account)))} right now`}</span>
            <button className="btn btn-quiet btn-sm" onClick={() => failed.forEach((s) => void ask(s.account, q!, s.state!.asked, signal()))}>
              Try again
            </button>
          </>
        )}
        {more.length > 0 && (
          <button className="btn btn-quiet btn-sm" onClick={() => more.forEach((s) => void ask(s.account, q!, s.state!.next, signal()))}>
            Show more
          </button>
        )}
      </>
    ),
  };
}

/** The line, placed after the last row of a list that is `top` pixels tall. */
export function RemoteLine({ top, children }: { top: number; children: ReactNode }) {
  return (
    <div className="remote-row" style={{ top }} role="status" aria-live="polite">
      {children}
    </div>
  );
}
