import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { displayName, ownAddresses } from "../lib/format.ts";
import { isPersonalDomain, quotedTerm } from "../lib/sorting.ts";
import { countText, useMatchCount } from "../lib/useMatchCount.ts";
import { refreshCounts } from "../store/counts.ts";
import { goView } from "../store/nav.ts";
import { refreshSession, useSession } from "../store/session.ts";
import { closeSortingDialog } from "../store/sorting.ts";
import { refreshSuggestions } from "../store/suggestions.ts";
import { useThread } from "../store/threads.ts";
import { toast } from "../store/toasts.ts";
import type { Account, ThreadDetail } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";

interface Choice {
  id: string;
  title: string;
  detail: string;
  query: string;
  /** What the split is called until the person types another name. */
  name: string;
}

const MAX_LABELS = 4;
const MAX_PEOPLE = 3;

const stem = (domain: string) => {
  const s = domain.split(".")[0] ?? domain;
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** The things a conversation lets someone split out: its sender, the sender's company, its mailing list, its labels, the people on it. */
export function choicesFor(detail: ThreadDetail, accounts: Account[]): Choice[] {
  const { sorting, thread } = detail;
  const out: Choice[] = [];
  const sender = sorting.sender;
  const brand = sender?.name || (sorting.domain ? stem(sorting.domain) : "");
  if (sender) {
    out.push({ id: "sender", title: sender.name || sender.email, detail: sender.name ? `This sender · ${sender.email}` : "This sender", query: quotedTerm("from", sender.email), name: brand || sender.email });
  }
  if (sorting.domain && !isPersonalDomain(sorting.domain)) {
    out.push({ id: "domain", title: sorting.domain, detail: "Everyone at this company", query: quotedTerm("domain", sorting.domain), name: brand || stem(sorting.domain) });
  }
  if (sorting.listId) {
    out.push({ id: "list", title: "This mailing list", detail: sorting.listId, query: quotedTerm("list", sorting.listId), name: brand || sorting.listId });
  }
  for (const l of thread.labels.slice(0, MAX_LABELS)) {
    out.push({ id: `label:${l}`, title: l, detail: "Label", query: quotedTerm("label", l), name: l });
  }
  const mine = ownAddresses(accounts);
  const seen = new Set<string>(sender ? [sender.email.toLowerCase()] : []);
  let people = 0;
  for (const p of thread.participants) {
    const email = p.email.toLowerCase();
    if (people >= MAX_PEOPLE) break;
    if (mine.has(email) || seen.has(email)) continue;
    seen.add(email);
    people++;
    out.push({ id: `person:${email}`, title: displayName(p), detail: `On this conversation · ${p.email}`, query: `${quotedTerm("from", p.email)} OR ${quotedTerm("to", p.email)}`, name: displayName(p) });
  }
  return out;
}

function ChoiceRow({ choice, index, selected, onPick, setRef }: { choice: Choice; index: number; selected: boolean; onPick: () => void; setRef: (el: HTMLButtonElement | null) => void }) {
  // Counts start a few at a time, so opening the dialog doesn't fire every search at once.
  const match = useMatchCount(choice.query, { inbox: true, delay: 120 + index * 80 });
  return (
    <button ref={setRef} type="button" role="radio" aria-checked={selected} tabIndex={selected ? 0 : -1} className="choice" onClick={onPick}>
      <span className="radio-dot" aria-hidden="true" />
      <span className="choice-text">
        <span className="choice-title ellipsis">{choice.title}</span>
        <span className="choice-detail ellipsis">{choice.detail}</span>
      </span>
      <span className="choice-count num" aria-live="polite">
        {countText(match)}
      </span>
    </button>
  );
}

/** New split from this conversation: pick what to split out, Enter makes it named for the choice, and the name can be changed first. */
export function NewSplitDialog({ threadId }: { threadId: string }) {
  const { detail, error, loading, retry } = useThread(threadId);
  const accounts = useSession((s) => s.accounts);
  const choices = useMemo(() => (detail ? choicesFor(detail, accounts) : []), [detail, accounts]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef(false);
  const nameField = useRef<HTMLInputElement>(null);

  const selected = choices.find((c) => c.id === selectedId) ?? choices[0] ?? null;
  const name = typed ?? selected?.name ?? "";

  // The name field takes focus as soon as there is something to name, even if the conversation was still loading.
  const ready = selected !== null;
  useEffect(() => {
    if (ready) nameField.current?.focus();
  }, [ready]);

  // Arrow keys pressed on a row keep focus on the row that is now chosen.
  useEffect(() => {
    if (!refocus.current || !selected) return;
    refocus.current = false;
    rows.current.get(selected.id)?.focus();
  }, [selected]);

  const move = (delta: number) => {
    if (!selected || choices.length < 2) return;
    const next = choices[(choices.indexOf(selected) + delta + choices.length) % choices.length]!;
    refocus.current = rows.current.get(selected.id) === document.activeElement;
    setSelectedId(next.id);
  };

  const create = async () => {
    const finalName = name.trim();
    if (!selected || !finalName || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const split = await api.createSplit(finalName, selected.query);
      await refreshSession();
      refreshCounts(true);
      void refreshSuggestions(true);
      closeSortingDialog();
      toast.action(`Added ${split.name}`, "Open", () => goView({ kind: "inbox", splitId: split.id }));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Couldn't add that split");
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" && (e.target as HTMLElement).getAttribute("role") === "radio") {
      // Enter on a choice makes the split; on the name field the form does.
      e.preventDefault();
      void create();
    }
  };

  return (
    <Dialog label="New split from this conversation" onClose={closeSortingDialog} className="dialog-narrow split-dialog" initialFocus="input" trapKeys>
      <div onKeyDown={onKeyDown}>
        <div className="dialog-head">
          <h3 aria-hidden="true">New split from this conversation</h3>
          <button className="icon-btn" aria-label="Close" onClick={closeSortingDialog}>
            <Icon name="x" />
          </button>
        </div>
        {error ? (
          <div className="move-state" role="alert">
            <p>Couldn't open this conversation.</p>
            <div className="form-actions">
              <button className="btn" onClick={retry}>
                Try again
              </button>
            </div>
          </div>
        ) : loading || !detail ? (
          <div className="move-state" aria-busy="true">
            <span className="skeleton-line" style={{ width: "58%" }} />
            <span className="skeleton-line" style={{ width: "90%" }} />
            <span className="skeleton-line" style={{ width: "74%" }} />
          </div>
        ) : choices.length === 0 ? (
          <p className="move-state">There's nothing in this conversation to split out.</p>
        ) : (
          <form
            className="split-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div className="move-group">
              <div className="move-label" id="split-by">
                Split out
              </div>
              <div className="choices" role="radiogroup" aria-labelledby="split-by">
                {choices.map((c, i) => (
                  <ChoiceRow
                    key={c.id}
                    choice={c}
                    index={i}
                    selected={c.id === selected?.id}
                    onPick={() => setSelectedId(c.id)}
                    setRef={(el) => (el ? rows.current.set(c.id, el) : rows.current.delete(c.id))}
                  />
                ))}
              </div>
            </div>
            <label className="form-row">
              <span>Name</span>
              <input
                ref={nameField}
                className="field"
                value={name}
                maxLength={60}
                onChange={(e) => setTyped(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {problem && (
              <div className="form-error" role="alert">
                {problem}
              </div>
            )}
            <div className="form-actions">
              <button type="button" className="btn btn-quiet" onClick={closeSortingDialog}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
                Add split
              </button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
