import { useEffect, useRef, useState } from "react";
import { viewTitle } from "../lib/views.ts";
import { act } from "../store/actions.ts";
import { useCounts } from "../store/counts.ts";
import { clearFilter, clearSelection, useList } from "../store/list.ts";
import { goView } from "../store/nav.ts";
import { navigate, type MailView } from "../store/route.ts";
import { useSession } from "../store/session.ts";
import { openPalette, ui, useUi } from "../store/ui.ts";
import { Icon } from "./Icon.tsx";
import { Keys } from "./Keycap.tsx";
import { MenuButton } from "./PageHeader.tsx";
import { AddSplitDialog } from "./SplitEditor.tsx";

const HINTS: { token: string; note: string }[] = [
  { token: "from:", note: "sender" },
  { token: "to:", note: "recipient" },
  { token: "has:attachment", note: "with files" },
  { token: "is:unread", note: "unread" },
  { token: "is:starred", note: "starred" },
  { token: "label:", note: "a label" },
  { token: "before:", note: "2026-10-01" },
  { token: "after:", note: "2026-09-01" },
  { token: "newer:7d", note: "last week" },
  { token: "in:sent", note: "sent mail" },
  { token: "in:all", note: "everywhere" },
];

export function MailHeader({ view }: { view: MailView }) {
  const selected = useList((s) => s.selected);
  const splits = useSession((s) => s.splits);
  const filter = useList((s) => s.filter);
  const searchOpen = useUi((s) => s.searchOpen) || view.kind === "search";

  const menu = <MenuButton />;

  if (selected.size > 0) return <BulkBar count={selected.size} leading={menu} />;

  return (
    <header className="mail-header">
      {menu}
      {searchOpen ? (
        <SearchField view={view} />
      ) : (
        <>
          {view.kind === "inbox" && splits.length > 0 ? <SplitTabs view={view} /> : <h1 className="view-title">{viewTitle(view, splits)}</h1>}
          <span className="grow" />
          {filter !== "all" && (
            <button className="filter-chip" onClick={clearFilter} aria-label="Clear filter">
              {filter === "unread" ? "Unread only" : "Starred only"}
              <Icon name="x" size={12} />
            </button>
          )}
          <button className="search-trigger" onClick={() => ui.set({ searchOpen: true })} aria-label="Search">
            <Icon name="search" />
            <span className="search-trigger-label">Search</span>
            <Keys binding="/" />
          </button>
        </>
      )}
    </header>
  );
}

function BulkBar({ count, leading }: { count: number; leading: React.ReactNode }) {
  return (
    <header className="mail-header bulk">
      {leading}
      <span className="bulk-count num">{count} selected</span>
      <span className="grow" />
      <button className="btn btn-sm" onClick={() => void act.done({ mouse: true })}>
        <Icon name="check" /> Done
      </button>
      <button className="btn btn-sm" onClick={() => act.remind({ mouse: true })}>
        <Icon name="clock" /> Remind
      </button>
      <button className="btn btn-sm" onClick={() => void act.star({ mouse: true })}>
        <Icon name="star" /> Star
      </button>
      <button className="btn btn-sm" onClick={() => openPalette("label")}>
        <Icon name="tag" /> Label
      </button>
      <button className="btn btn-sm btn-danger" onClick={() => void act.trash({ mouse: true })}>
        <Icon name="trash" /> Trash
      </button>
      <button className="icon-btn" aria-label="Clear selection" onClick={clearSelection}>
        <Icon name="x" />
      </button>
    </header>
  );
}

function SplitTabs({ view }: { view: Extract<MailView, { kind: "inbox" }> }) {
  const splits = useSession((s) => s.splits);
  const counts = useCounts();
  const [adding, setAdding] = useState(false);
  const activeId = view.splitId ?? splits[0]?.id;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = splits.findIndex((s) => s.id === activeId);
    const next = splits[(i + (e.key === "ArrowRight" ? 1 : -1) + splits.length) % splits.length];
    if (next) goView({ kind: "inbox", splitId: next.id });
    e.preventDefault();
  };

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Splits" onKeyDown={onKey}>
        {splits.map((s) => {
          const unread = counts?.splits[s.id]?.unread ?? 0;
          const active = s.id === activeId;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className="tab"
              onClick={() => goView({ kind: "inbox", splitId: s.id })}
            >
              {s.name}
              {unread > 0 && <span className="tab-count num">{unread}</span>}
            </button>
          );
        })}
        <button className="tab tab-add" aria-label="Add a split" title="Add a split" onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      {adding && <AddSplitDialog onClose={() => setAdding(false)} />}
    </>
  );
}

function SearchField({ view }: { view: MailView }) {
  const initial = view.kind === "search" ? view.q : "";
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);

  // Focus it when the user opened search; a results page loaded by URL leaves focus on the list.
  useEffect(() => {
    if (!ui.get().searchOpen) return;
    input.current?.focus();
    input.current?.select();
  }, []);
  useEffect(() => {
    if (view.kind === "search") setValue(view.q);
  }, [view]);

  const close = () => {
    ui.set({ searchOpen: false });
    if (view.kind === "search") navigate("/");
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    input.current?.blur();
    ui.set({ searchOpen: false });
    navigate(`/search?q=${encodeURIComponent(q)}`);
  };
  const addToken = (token: string) => {
    const spaced = value && !value.endsWith(" ") ? `${value} ` : value;
    setValue(`${spaced}${token}`);
    input.current?.focus();
  };

  return (
    <form className="search-field" role="search" onSubmit={submit}>
      <Icon name="search" />
      <input
        ref={input}
        className="search-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
        placeholder="Search mail"
        aria-label="Search mail"
        spellCheck={false}
        autoComplete="off"
      />
      <button type="button" className="icon-btn" aria-label="Close search" onClick={close}>
        <Icon name="x" />
      </button>
      {(
        <div className="search-hints" aria-label="Search operators">
          <div className="search-hints-title">Narrow it down</div>
          <div className="hint-list">
            {HINTS.map((h) => (
              <button key={h.token} type="button" className="hint" onMouseDown={(e) => e.preventDefault()} onClick={() => addToken(h.token)}>
                <code>{h.token}</code>
                <span>{h.note}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </form>
  );
}
