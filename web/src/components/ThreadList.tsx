import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useViewport } from "../lib/hooks.ts";
import { act } from "../store/actions.ts";
import { focusId, list, loadMore, toggleSelected, useList } from "../store/list.ts";
import { openThread } from "../store/nav.ts";
import { prefetch } from "../store/threads.ts";
import { logosFor, useLogoPolicy, useSession } from "../store/session.ts";
import { RemoteLine } from "./RemoteSearch.tsx";
import { ThreadRow } from "./ThreadRow.tsx";

const OVERSCAN = 8;
/** Room after the last row for the line about searching the provider. */
const FOOTER_H = 44;

/** Where the list was scrolled when it last left the screen, so coming back from a conversation lands in the same place. */
let savedScroll: { key: string; top: number } | null = null;

/** A windowed list: only the rows near the viewport exist in the DOM, so 50k conversations scroll like 50. */
export function ThreadList({ activeId, compact = false, footer }: { activeId?: string | null; compact?: boolean; footer?: ReactNode }) {
  const rows = useList((s) => s.visible);
  const focusedId = useList((s) => s.focusedId);
  const selected = useList((s) => s.selected);
  const hasNext = useList((s) => Boolean(s.next));
  const resetToken = useList((s) => s.resetToken);
  const accounts = useSession((s) => s.accounts);
  const accountFilter = useSession((s) => s.accountFilter);
  const density = useSession((s) => s.settings.density);
  const logoPolicy = useLogoPolicy();
  const viewport = useViewport();

  const twoLine = viewport === "mobile" || compact;
  const rowH = twoLine ? 70 : density === "compact" ? 34 : 40;
  const scroller = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ top: 0, height: 700 });
  const raf = useRef(0);

  const measure = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) setRange((r) => (r.top === el.scrollTop && r.height === el.clientHeight ? r : { top: el.scrollTop, height: el.clientHeight }));
    });
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    setRange({ top: el.scrollTop, height: el.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // Returning from a conversation keeps the scroll position; a different mailbox starts at the top.
  const lastToken = useRef(resetToken);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && savedScroll && savedScroll.key === list.get().key) {
      el.scrollTop = savedScroll.top;
      setRange({ top: el.scrollTop, height: el.clientHeight });
    }
    savedScroll = null;
    return () => {
      if (scroller.current) savedScroll = { key: list.get().key, top: scroller.current.scrollTop };
    };
  }, []);
  useEffect(() => {
    if (lastToken.current === resetToken) return;
    lastToken.current = resetToken;
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [resetToken]);

  // Keep the focused row on screen when the keyboard moves it.
  const focusIndex = focusedId ? rows.findIndex((t) => t.id === focusedId) : -1;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || focusIndex < 0) return;
    const top = focusIndex * rowH;
    const bottom = top + rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [focusIndex, rowH]);

  const start = Math.max(0, Math.floor(range.top / rowH) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((range.top + range.height) / rowH) + OVERSCAN);

  // Page in more as the end approaches.
  useEffect(() => {
    if (hasNext && end >= rows.length - 40) void loadMore();
  }, [hasNext, end, rows.length]);

  // Warm the cache for the focused row and its neighbours so Enter is instant.
  useEffect(() => {
    if (focusIndex < 0) return;
    const t = setTimeout(() => prefetch([rows[focusIndex]?.id, rows[focusIndex + 1]?.id, rows[focusIndex - 1]?.id, rows[focusIndex + 2]?.id]), 60);
    return () => clearTimeout(t);
  }, [focusIndex, rows]);

  const onOpen = useCallback((id: string, e: MouseEvent) => {
    if (e.shiftKey) {
      const s = list.get();
      const a = s.visible.findIndex((t) => t.id === (s.focusedId ?? id));
      const b = s.visible.findIndex((t) => t.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      list.set({ selected: new Set(s.visible.slice(lo, hi + 1).map((t) => t.id)), focusedId: id });
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      toggleSelected(id);
      focusId(id);
      return;
    }
    openThread(id);
  }, []);

  const onDone = useCallback((id: string) => void act.done({ ids: [id], mouse: true }), []);
  const onRemind = useCallback((id: string) => act.remind({ ids: [id], mouse: true }), []);
  const onStar = useCallback((id: string) => void act.star({ ids: [id], mouse: true }), []);

  const selecting = selected.size > 0;
  const showAccount = accounts.length > 1 && !accountFilter;

  return (
    <div
      ref={scroller}
      className={`list-scroll ${twoLine ? "two-line" : ""}`}
      data-list-root
      role="listbox"
      aria-label="Conversations"
      aria-multiselectable="true"
      aria-activedescendant={focusedId ? `row-${focusedId}` : undefined}
      tabIndex={0}
      onScroll={measure}
    >
      <div className="list-canvas" style={{ height: rows.length * rowH + (footer ? FOOTER_H : 0) }}>
        {footer && <RemoteLine top={rows.length * rowH}>{footer}</RemoteLine>}
        {rows.slice(start, end).map((t, i) => (
          <ThreadRow
            key={t.id}
            thread={t}
            top={(start + i) * rowH}
            height={rowH}
            focused={t.id === (activeId ?? focusedId)}
            selected={selected.has(t.id)}
            selecting={selecting}
            accounts={accounts}
            showAccount={showAccount}
            logos={logosFor(logoPolicy, accounts.find((a) => a.id === t.accountId))}
            onOpen={onOpen}
            onToggle={toggleSelected}
            onDone={onDone}
            onRemind={onRemind}
            onStar={onStar}
          />
        ))}
      </div>
    </div>
  );
}
