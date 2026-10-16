import { useEffect, useRef, useState } from "react";
import { Composer } from "../components/Composer.tsx";
import { AgentTrail } from "../components/AgentTrail.tsx";
import { AssistantButton } from "../components/AssistantButton.tsx";
import { ContextPane } from "../components/ContextPane.tsx";
import { EmptyState } from "../components/InboxZero.tsx";
import { Icon } from "../components/Icon.tsx";
import { Keys } from "../components/Keycap.tsx";
import { LabelChip } from "../components/labels/LabelChip.tsx";
import { MessageCard } from "../components/MessageCard.tsx";
import { useDismiss, useViewport } from "../lib/hooks.ts";
import { act } from "../store/actions.ts";
import { openDraft, startReply, useCompose } from "../store/compose.ts";
import { list, useList } from "../store/list.ts";
import { closeThread, unsubscribeFrom } from "../store/nav.ts";
import { navigate, routeFrom } from "../store/route.ts";
import { codeMessage } from "../lib/code.ts";
import { logosFor, useLogoPolicy, useSession } from "../store/session.ts";
import { useThread } from "../store/threads.ts";
import { enterThread, toggleMessage, useThreadView } from "../store/threadView.ts";
import { openPalette, toggleContext, useUi } from "../store/ui.ts";
import type { ThreadDetail } from "../types.ts";
import type { ComposeKind } from "../lib/compose.ts";

export function ThreadView({ id, showContext }: { id: string; showContext: boolean }) {
  const { detail, error, loading, retry } = useThread(id);
  const accounts = useSession((s) => s.accounts);
  const logoPolicy = useLogoPolicy();
  const viewport = useViewport();
  const contextOpen = useUi((s) => s.contextOpen);
  const expanded = useThreadView((s) => s.expanded);
  const focus = useThreadView((s) => s.focus);
  const scrollTick = useThreadView((s) => s.scrollTick);
  const scroller = useRef<HTMLDivElement>(null);
  const markedRead = useRef<string | null>(null);

  const messages = detail?.messages ?? [];
  const logos = logosFor(logoPolicy, accounts.find((a) => a.id === detail?.thread.accountId));
  const codeId = codeMessage(messages)?.id;
  const ids = messages.map((m) => m.id).join();

  useEffect(() => {
    if (detail) enterThread(id, detail.messages.map((m) => m.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ids]);

  // Opening a conversation reads it, once.
  useEffect(() => {
    if (!detail || markedRead.current === id) return;
    markedRead.current = id;
    if (detail.thread.unread) void act.markRead([id]);
  }, [detail, id]);

  // n and p bring the focused message into view.
  useEffect(() => {
    if (!scrollTick) return;
    const m = messages[focus];
    scroller.current?.querySelector(`[data-message-id="${m?.id}"]`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTick]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [id]);

  const startReplying = (kind: Exclude<ComposeKind, "new">) => {
    if (detail) startReply(detail, kind, viewport !== "mobile");
  };

  if (error) {
    return (
      <section className="thread-pane">
        <ThreadBar subject="" />
        <div className="state-block">
          <EmptyState title={/not found/i.test(error) ? "This conversation isn't here anymore" : "Couldn't open this conversation"} hint={/not found/i.test(error) ? undefined : error} />
          <span className="state-actions">
            {!/not found/i.test(error) && (
              <button className="btn" onClick={retry}>
                Try again
              </button>
            )}
            <button className="btn btn-quiet" onClick={closeThread}>
              Back to list
            </button>
          </span>
        </div>
      </section>
    );
  }

  return (
    <div className={`thread-layout ${showContext && contextOpen && viewport === "desktop" ? "with-context" : ""}`}>
      <section className="thread-pane" aria-label="Conversation">
        <ThreadBar subject={detail?.thread.subject ?? ""} detail={detail} />
        <div className="thread-scroll" data-thread-scroll ref={scroller}>
          {loading || !detail ? (
            <div className="thread-skeleton" aria-busy="true" aria-label="Loading conversation">
              <span style={{ width: "42%" }} />
              <span style={{ width: "90%" }} />
              <span style={{ width: "80%" }} />
              <span style={{ width: "64%" }} />
            </div>
          ) : (
            <div className="thread-inner">
              <h1 className="thread-subject">{detail.thread.subject || "(no subject)"}</h1>
              <div className="thread-labels">
                {detail.thread.labels.map((l) => (
                  <LabelChip key={l} name={l} />
                ))}
              </div>
              <AgentTrail threadId={detail.thread.id} draftId={detail.draftId} />
              {messages.map((m, i) => (
                <MessageCard
                  key={m.id}
                  message={m}
                  expanded={expanded.has(m.id)}
                  focused={i === focus}
                  accounts={accounts}
                  logos={logos}
                  codeShortcut={m.id === codeId}
                  onToggle={() => toggleMessage(m.id)}
                  onReply={startReplying}
                />
              ))}
              <ReplyDock detail={detail} onReply={startReplying} />
            </div>
          )}
        </div>
        {detail && viewport === "mobile" && <MobileBar detail={detail} onReply={startReplying} />}
      </section>
      {showContext && contextOpen && viewport === "desktop" && detail && <ContextPane detail={detail} />}
    </div>
  );
}

function ReplyDock({ detail, onReply }: { detail: ThreadDetail; onReply: (k: Exclude<ComposeKind, "new">) => void }) {
  const inline = useCompose((s) => s.open && s.inline && s.threadId === detail.thread.id);
  const viewport = useViewport();
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (inline) dock.current?.scrollIntoView({ block: "nearest" });
  }, [inline]);
  if (inline && viewport !== "mobile") {
    return (
      <div className="reply-dock" ref={dock}>
        <Composer placement="inline" />
      </div>
    );
  }
  return (
    <div className="reply-bar">
      {detail.draftId ? (
        <button className="reply-draft" onClick={() => void openDraft(detail.draftId!)}>
          <Icon name="file" /> Continue your draft
        </button>
      ) : null}
      <button className="reply-btn" onClick={() => onReply("reply")}>
        <Icon name="reply" /> Reply <Keys binding="r" />
      </button>
      <button className="reply-btn" onClick={() => onReply("replyAll")}>
        <Icon name="reply-all" /> Reply all <Keys binding="enter" />
      </button>
      <button className="reply-btn" onClick={() => onReply("forward")}>
        <Icon name="forward" /> Forward <Keys binding="f" />
      </button>
    </div>
  );
}

function ThreadBar({ subject, detail }: { subject: string; detail?: ThreadDetail | null }) {
  const viewport = useViewport();
  const rows = useList((s) => s.visible);
  const id = detail?.thread.id;
  const idx = id ? rows.findIndex((t) => t.id === id) : -1;
  const starred = detail?.thread.starred ?? false;
  const go = (delta: number) => {
    const next = rows[idx + delta];
    if (!next) return;
    list.set({ focusedId: next.id });
    navigate(`/t/${next.id}`, { replace: true, from: routeFrom() });
  };

  return (
    <header className="thread-bar">
      <button className="icon-btn tap" aria-label="Back to list" title="Back (Esc)" onClick={closeThread}>
        <Icon name="chevron-left" size={18} />
      </button>
      {viewport !== "mobile" && <span className="thread-bar-subject ellipsis">{subject}</span>}
      <span className="grow" />
      {detail && viewport !== "mobile" && (
        <>
          <button className="btn btn-sm" onClick={() => void act.done({ mouse: true })}>
            <Icon name="check" /> Done <Keys binding="e" />
          </button>
          <button className="btn btn-sm" onClick={() => act.remind({ mouse: true })}>
            <Icon name="clock" /> Remind <Keys binding="h" />
          </button>
          <button className="icon-btn star-btn" aria-label={starred ? "Remove star" : "Star"} aria-pressed={starred} title="Star (S)" onClick={() => void act.star({ mouse: true })}>
            <Icon name="star" />
          </button>
          <button className="icon-btn" aria-label="Label" title="Label (L)" onClick={() => openPalette("label", [detail.thread.id])}>
            <Icon name="tag" />
          </button>
          <button className="icon-btn" aria-label="Trash" title="Trash (#)" onClick={() => void act.trash({ mouse: true })}>
            <Icon name="trash" />
          </button>
          <MoreMenu detail={detail} />
          <button className="icon-btn" aria-label="Previous conversation" title="Previous (K)" disabled={idx <= 0} onClick={() => go(-1)}>
            <Icon name="chevron-left" />
          </button>
          <button className="icon-btn" aria-label="Next conversation" title="Next (J)" disabled={idx < 0 || idx >= rows.length - 1} onClick={() => go(1)}>
            <Icon name="chevron-right" />
          </button>
        </>
      )}
      <AssistantButton compact />
    </header>
  );
}

function MoreMenu({ detail, up = false, className = "icon-btn" }: { detail: ThreadDetail; up?: boolean; className?: string }) {
  const viewport = useViewport();
  const contextOpen = useUi((s) => s.contextOpen);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const hasUnsub = detail.messages.some((m) => m.canUnsubscribe);
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="more" ref={ref}>
      <button className={className} aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" size={viewport === "mobile" ? 20 : 16} />
        {viewport === "mobile" && "More"}
      </button>
      {open && (
        <div className={`menu menu-right ${up ? "menu-up" : ""}`} role="menu">
          <MenuItem label={detail.thread.unread ? "Mark read" : "Mark unread"} keys="u" onPick={pick(() => void act.toggleRead())} />
          <MenuItem label="Move to…" keys="v" onPick={pick(() => openPalette("move", [detail.thread.id]))} />
          {viewport === "mobile" && <MenuItem label={detail.thread.starred ? "Remove star" : "Star"} keys="s" onPick={pick(() => void act.star())} />}
          {viewport === "mobile" && <MenuItem label="Label…" keys="l" onPick={pick(() => openPalette("label", [detail.thread.id]))} />}
          <MenuItem label="Mute" keys="shift+m" onPick={pick(() => void act.mute())} />
          <MenuItem label="Report spam" keys="!" onPick={pick(() => void act.spam())} />
          {hasUnsub && <MenuItem label="Unsubscribe" keys="mod+u" onPick={pick(() => void unsubscribeFrom([detail.thread.id]))} />}
          {viewport === "mobile" && <MenuItem label="Trash" keys="#" onPick={pick(() => void act.trash())} />}
          {viewport === "desktop" && <MenuItem label={contextOpen ? "Hide contact pane" : "Show contact pane"} onPick={pick(toggleContext)} />}
        </div>
      )}
    </div>
  );
}

function MenuItem({ label, keys, onPick }: { label: string; keys?: string; onPick: () => void }) {
  return (
    <button className="menu-item" role="menuitem" onClick={onPick}>
      <span className="grow">{label}</span>
      {keys && <Keys binding={keys} />}
    </button>
  );
}

function MobileBar({ detail, onReply }: { detail: ThreadDetail; onReply: (k: Exclude<ComposeKind, "new">) => void }) {
  return (
    <nav className="mobile-bar" aria-label="Conversation actions">
      <button className="mobile-act" onClick={() => void act.done({ mouse: true })}>
        <Icon name="check" size={20} />
        Done
      </button>
      <button className="mobile-act" onClick={() => act.remind({ mouse: true })}>
        <Icon name="clock" size={20} />
        Remind
      </button>
      <button className="mobile-act" onClick={() => onReply("reply")}>
        <Icon name="reply" size={20} />
        Reply
      </button>
      <MoreMenu detail={detail} up className="mobile-act" />
    </nav>
  );
}
