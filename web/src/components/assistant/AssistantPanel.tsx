import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../api.ts";
import { agoShort, longTime } from "../../lib/format.ts";
import { contextMarker, groupRuns, runText } from "../../lib/cloudText.ts";
import { useNow, useViewport, useWindowWidth } from "../../lib/hooks.ts";
import { scopeSentence } from "../../lib/scopes.ts";
import { assistant, ASSISTANT_INLINE_MIN, ASSISTANT_MAX, ASSISTANT_MIN, newChat, setDraft, setOpen, setWidth, showRun, useAssistant } from "../../store/assistant.ts";
import { dollars, loadHistory, modelName, refreshCloud, replyToRun, RUN_ACTIVE, runError, startRun, statusLabel, stopRun, upsertRun, useCloud } from "../../store/cloud.ts";
import { refreshEngines, useAssistantName, useCanRun, useEffectiveEngine, useEngines } from "../../store/engines.ts";
import { assistantName, engineLine, shortModel } from "../../lib/engines.ts";
import { useReview } from "../../store/agents.ts";
import { navigate } from "../../store/route.ts";
import type { CloudRun, CloudStatus } from "../../types.ts";
import { Icon } from "../Icon.tsx";
import { Keys } from "../Keycap.tsx";
import { EnginePicker } from "./EnginePicker.tsx";
import { Transcript } from "./Transcript.tsx";
import { useAssistantContext } from "./useContext.ts";

/** The assistant lives beside every screen: inline on desktop, a full-height sheet below it. */
export function AssistantHost() {
  const open = useAssistant((s) => s.open);
  const viewport = useViewport();
  const windowWidth = useWindowWidth();
  const name = useAssistantName();
  if (viewport === "desktop" && windowWidth >= ASSISTANT_INLINE_MIN) {
    return (
      <aside className="assistant" aria-label={name} aria-hidden={!open} inert={!open}>
        {open && <Resizer />}
        {open && <Panel sheet={false} />}
      </aside>
    );
  }
  if (!open) return null;
  return <Sheet name={name} />;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The sheet is modal: focus moves in, Tab stays inside, Escape closes, and focus goes back where it was. */
function Sheet({ name }: { name: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((n) => n.offsetParent !== null);
    const first = nodes[0];
    const last = nodes.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="assistant-scrim" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <aside ref={ref} className="assistant assistant-sheet" role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} onKeyDown={onKeyDown}>
        <Panel sheet />
      </aside>
    </div>
  );
}

/** Drag the left edge, or use the arrow keys when it has focus. */
function Resizer() {
  const width = useAssistant((s) => s.width);
  const drag = useRef(false);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    document.querySelector(".app")?.classList.add("resizing");
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current) setWidth(window.innerWidth - e.clientX - 8);
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = false;
    document.querySelector(".app")?.classList.remove("resizing");
    setWidth(assistant.get().width, true);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    const w = assistant.get().width;
    const next = e.key === "ArrowLeft" ? w + step : e.key === "ArrowRight" ? w - step : e.key === "Home" ? ASSISTANT_MAX : e.key === "End" ? ASSISTANT_MIN : null;
    if (next === null) return;
    e.preventDefault();
    setWidth(next, true);
  };
  return (
    <div
      className="assistant-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the assistant"
      aria-valuemin={ASSISTANT_MIN}
      aria-valuemax={ASSISTANT_MAX}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKey}
    />
  );
}

function Panel({ sheet }: { sheet: boolean }) {
  const status = useCloud((s) => s.status);
  const error = useCloud((s) => s.error);
  const view = useAssistant((s) => s.view);
  const runId = useAssistant((s) => s.runId);
  const overview = useEngines((s) => s.overview);
  const canRun = useCanRun();
  const name = useAssistantName();

  useEffect(() => {
    if (!status) void refreshCloud();
  }, [status]);
  useEffect(() => {
    if (!overview) void refreshEngines();
  }, [overview]);

  return (
    <div className="as">
      <header className="as-head">
        <h2 className="as-title">{name}</h2>
        <span className="grow" />
        {canRun && (
          <>
            <button className="icon-btn" aria-label="Past chats" aria-pressed={view === "history"} title="Past chats" onClick={() => assistant.set({ view: view === "history" ? "chat" : "history" })}>
              <Icon name="clock" />
            </button>
            <button className="icon-btn" aria-label="New chat" title="New chat" disabled={runId === null && view === "chat"} onClick={newChat}>
              <Icon name="plus" />
            </button>
            <button className="icon-btn" aria-label="Routines and settings" title="Routines and settings" onClick={() => (navigate("/agent"), sheet && setOpen(false))}>
              <Icon name="settings" />
            </button>
          </>
        )}
        <button className="icon-btn" aria-label="Close" title="Close (⌘.)" onClick={() => setOpen(false)}>
          <Icon name="x" />
        </button>
      </header>
      {!status ? (
        error ? (
          <div className="as-state">
            <p>{error}</p>
            <button className="btn" onClick={() => void refreshCloud()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="rv-skeleton as-skeleton" aria-busy="true" aria-label="Loading the assistant">
            <span />
            <span />
          </div>
        )
      ) : !overview && !status.connected ? (
        <div className="rv-skeleton as-skeleton" aria-busy="true" aria-label="Loading the assistant">
          <span />
        </div>
      ) : !canRun ? (
        <div className="as-scroll">
          <NoModel sheet={sheet} />
        </div>
      ) : view === "history" ? (
        <History />
      ) : (
        <Chat status={status} sheet={sheet} />
      )}
    </div>
  );
}

// ---- Conversation ---------------------------------------------------------------------------

/** Keep the newest line in view while the person hasn't scrolled away; a different conversation starts at the bottom. */
function useStickToBottom(ref: React.RefObject<HTMLDivElement | null>, resetKey: string | null, deps: unknown[]) {
  const near = useRef(true);
  useEffect(() => {
    near.current = true;
  }, [resetKey]);
  useEffect(() => {
    const el = ref.current;
    if (el && near.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, ...deps]);
  return (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
}

function Chat({ status, sheet }: { status: CloudStatus; sheet: boolean }) {
  const runId = useAssistant((s) => s.runId);
  const run = useCloud((s) => s.status?.runs.find((r) => r.id === runId));
  const pending = useReview((s) => s.pending);
  const scroller = useRef<HTMLDivElement>(null);
  const now = useNow();

  // A remembered conversation that isn't in the latest twenty: fetch it, or start fresh if it's gone.
  useEffect(() => {
    if (!runId || run) return;
    api
      .cloudRun(runId)
      .then(upsertRun)
      .catch(() => showRun(null));
  }, [runId, run]);

  // The server records which run asked for each approval.
  const approvals = useMemo(() => (run ? (pending ?? []).filter((a) => a.runId === run.id) : []), [pending, run]);

  const onScroll = useStickToBottom(scroller, runId, [run?.transcript.length, run?.status, approvals.length]);

  if (!runId) {
    return (
      <>
        <div className="as-scroll" ref={scroller}>
          <FreshChat status={status} />
        </div>
        <Composer status={status} run={undefined} sheet={sheet} />
      </>
    );
  }
  if (!run) {
    return (
      <div className="rv-skeleton as-skeleton" aria-busy="true" aria-label="Loading the conversation">
        <span />
      </div>
    );
  }
  return (
    <>
      <div className="as-scroll" ref={scroller} onScroll={onScroll} aria-label="Conversation" tabIndex={0}>
        <Transcript run={run} approvals={approvals} />
        <RunFooter run={run} now={now} />
      </div>
      <Composer status={status} run={run} sheet={sheet} />
    </>
  );
}

/** 950 stays 950; 12,400 reads 12.4k; 1,500,000 reads 1.5M. */
function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function RunFooter({ run, now }: { run: CloudRun; now: number }) {
  const active = RUN_ACTIVE.has(run.status);
  const label = useEngines((s) => s.overview?.engines.find((e) => e.id === run.engine)?.label);
  const bits = [
    label ? (run.model ? `${label} · ${shortModel(run.model)}` : label) : run.model ? shortModel(run.model) : null,
    run.toolCalls > 0 ? `${run.toolCalls} ${run.toolCalls === 1 ? "action" : "actions"}` : null,
    run.costCents !== null ? dollars(run.costCents) : null,
    run.tokens && run.tokens.input + run.tokens.output > 0 ? `${tokenCount(run.tokens.input + run.tokens.output)} tokens` : null,
  ].filter(Boolean);
  return (
    <footer className="as-meta">
      {!active && run.status !== "done" && <span className={`as-state-tag as-${run.status}`}>{statusLabel(run.status)}</span>}
      <span className="num">{bits.join(" · ")}</span>
      <time className="num" dateTime={new Date(run.createdAt).toISOString()} title={longTime(run.createdAt)}>
        {agoShort(run.createdAt, now)}
      </time>
      {run.toolCalls > 0 && (
        <button className="trail-act" onClick={() => navigate(run.agentId ? `/activity?agent=${encodeURIComponent(run.agentId)}` : "/activity")}>
          View activity
        </button>
      )}
    </footer>
  );
}

function FreshChat({ status }: { status: CloudStatus }) {
  const engine = useEffectiveEngine();
  const managed = engine?.id === "managed:anthropic";
  const spent = status.spentThisMonthCents;
  const cap = status.monthlyBudgetCents;
  return (
    <div className="as-fresh">
      <h3>What should {assistantName(engine?.id)} do?</h3>
      <p>
        {managed && status.agent ? `It can ${scopeSentence(status.agent.scopes)} through your Slipstream permissions.` : "It works through your Slipstream permissions. Anything it sends waits for you in Review."}{" "}
        <button className="as-link" onClick={() => (managed ? assistant.set({ accessOpen: true }) : navigate("/settings/models"))}>
          Change
        </button>
      </p>
      {engine && (
        <p className="as-quiet num">
          {engine.billing === "api" ? `${dollars(spent)} of ${dollars(cap)} this month · ` : ""}
          {managed ? modelName(status.model) : engineLine(engine)}
        </p>
      )}
    </div>
  );
}

/** Nothing can run an agent yet: say so, and where to fix it. */
function NoModel({ sheet }: { sheet: boolean }) {
  return (
    <div className="as-fresh">
      <h3>Choose a model first</h3>
      <p>Connect your ChatGPT plan, add an API key, or use Claude Code or Codex. Then ask for anything in your mail.</p>
      <button className="btn btn-primary as-setup" onClick={() => (navigate("/settings/models"), sheet && setOpen(false))}>
        Set up a model
      </button>
    </div>
  );
}

// ---- Composer ---------------------------------------------------------------------------------

const QUICK_THREAD = [
  { label: "Summarize", text: "Summarize this conversation." },
  { label: "Draft a reply", text: "Draft a reply to this conversation." },
  { label: "Find related", text: "Find other conversations related to this one." },
  { label: "Remind me when they reply", text: "Remind me about this conversation if they haven't replied within a week." },
];
const QUICK_SELECTION = [
  { label: "Label these…", text: "Label these conversations as " },
  { label: "Triage these", text: "Triage these conversations: mark done what doesn't need me and remind me about the rest." },
];

function Composer({ status, run, sheet }: { status: CloudStatus; run: CloudRun | undefined; sheet: boolean }) {
  const draft = useAssistant((s) => s.draft);
  const [followUp, setFollowUp] = useState("");
  const text = run ? followUp : draft;
  const setText = run ? setFollowUp : setDraft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; budget: boolean } | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const field = useRef<HTMLTextAreaElement>(null);
  const chips = useAssistantContext();
  const engine = useEffectiveEngine();
  // A chat that has started stays on its engine; a new one uses what the picker shows.
  const who = assistantName(run?.engine ?? engine?.id);
  const sig = chips.map((c) => c.key).join("|");

  useEffect(() => setDismissed(new Set()), [sig]);
  useEffect(() => {
    setError(null);
    setFollowUp("");
  }, [run?.id]);
  // Opening the panel puts the cursor in the box (on a phone that would raise the keyboard, so leave it).
  useEffect(() => {
    if (!sheet) field.current?.focus();
  }, [sheet, run?.id]);
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  const active = run ? RUN_ACTIVE.has(run.status) : false;
  // A budget stop can't continue. A failed managed run can't either; other engines take a follow-up (a plan limit may have lifted).
  const closed = run ? run.status === "budget" || (run.status === "failed" && (!run.engine || run.engine === "managed:anthropic")) : false;
  const live = chips.filter((c) => !dismissed.has(c.key));
  const quick = !run && live.length > 0 ? (live[0]!.kind === "thread" ? QUICK_THREAD : QUICK_SELECTION) : [];

  const send = async () => {
    const t = text.trim();
    if (!t || busy || active) return;
    setBusy(true);
    setError(null);
    try {
      if (run) {
        // A follow-up can't carry structured context, so what's on screen rides along as a reference line.
        const refs = live.map((c) => contextMarker(c.short, c.threadIds)).join("\n");
        await replyToRun(run.id, refs ? `${t}\n\n${refs}` : t);
        setFollowUp("");
      } else {
        const ids = live.flatMap((c) => c.threadIds);
        const started = await startRun(t, ids.length ? { threadIds: ids } : undefined, engine?.id);
        setDraft("");
        showRun(started.id);
      }
    } catch (err) {
      setError({ text: runError(err), budget: err instanceof ApiError && err.status === 402 });
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    void send();
  };

  if (closed && run) {
    return (
      <div className="as-composer as-closed">
        <p>{run.status === "budget" ? "This chat reached its budget." : "This chat stopped early."}</p>
        <button className="btn" onClick={newChat}>
          Start a new chat
        </button>
      </div>
    );
  }

  return (
    <div className="as-composer">
      {quick.length > 0 && (
        <div className="as-quick" role="group" aria-label="Suggestions">
          {quick.map((q) => (
            <button
              key={q.label}
              className="as-quick-btn"
              onClick={() => {
                setText(q.text);
                field.current?.focus();
              }}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="form-error as-error" role="alert">
          {error.text}
          {error.budget && (
            <button className="as-link" onClick={() => (status.connected ? assistant.set({ accessOpen: true }) : navigate("/settings/models"))}>
              Raise the budget
            </button>
          )}
        </div>
      )}
      <div className={`as-box ${busy ? "busy" : ""}`}>
        {live.length > 0 && (
          <ul className="as-chips" role="list" aria-label="Context sent with your message">
            {live.map((c) => (
              <li key={c.key} className="as-chip">
                <Icon name={c.kind === "thread" ? "mail" : "check-circle"} size={13} />
                <span className="ellipsis">{c.label}</span>
                <button aria-label={`Remove: ${c.label}`} onClick={() => setDismissed((d) => new Set(d).add(c.key))}>
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={field}
          data-assistant-input
          className="as-input"
          rows={1}
          value={text}
          disabled={active}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={active ? `${who} is working…` : run ? `Reply to ${who}…` : `Ask ${who}…`}
          aria-label={run ? `Reply to ${who}` : `Ask ${who}`}
          title="Shift+Enter for a new line"
          maxLength={8000}
        />
        <div className="as-actions">
          {!run && <EnginePicker onSetup={() => sheet && setOpen(false)} />}
          <span className="grow" />
          {active && run ? (
            <button className="btn btn-sm" onClick={() => void stopRun(run.id)} disabled={run.status !== "running"}>
              Stop
            </button>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={() => void send()} disabled={busy || !text.trim()} aria-label={run ? "Send reply" : `Ask ${who}`}>
              {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="arrow-up" size={14} />}
              {run ? "Reply" : "Ask"} <Keys binding="enter" />
            </button>
          )}
        </div>
      </div>
      {status.agent && !sheet && engine?.id === "managed:anthropic" && <div className="sr-only">Claude can {scopeSentence(status.agent.scopes)}.</div>}
    </div>
  );
}

// ---- Past chats ----------------------------------------------------------------------------------

function History() {
  const all = useCloud((s) => s.status?.runs);
  // Runs Autopilot started belong to Autopilot, not to your chats.
  const runs = useMemo(() => (all ?? []).filter((r) => r.origin !== "autopilot"), [all]);
  const current = useAssistant((s) => s.runId);
  const [q, setQ] = useState("");
  const now = useNow();
  useEffect(() => void loadHistory(), []);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? runs.filter((r) => runText(r).includes(needle)) : runs;
  }, [runs, q]);
  const groups = useMemo(() => groupRuns(shown, now), [shown, now]);

  return (
    <div className="as-history">
      <div className="as-search">
        <Icon name="search" size={15} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" autoComplete="off" autoFocus />
      </div>
      <button className="as-new" onClick={newChat}>
        <Icon name="plus" size={15} /> New chat
      </button>
      <div className="as-scroll as-list">
        {groups.length === 0 ? (
          <p className="as-empty">{q.trim() ? `No chats match “${q.trim()}”.` : "Your chats will show up here."}</p>
        ) : (
          groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <h3 className="as-group">{g.label}</h3>
              <ul role="list">
                {g.runs.map((r) => (
                  <li key={r.id}>
                    <button className="as-row" aria-current={r.id === current ? "true" : undefined} onClick={() => showRun(r.id)}>
                      <span className={`as-dot as-${r.status}`} aria-hidden="true" />
                      <span className="as-row-text ellipsis">{r.instruction}</span>
                      <span className="sr-only">{statusLabel(r.status)}</span>
                      <time className="as-row-time num" dateTime={new Date(r.createdAt).toISOString()}>
                        {agoShort(r.createdAt, now)}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
