import { useEffect, useMemo, useRef } from "react";
import { EmptyState } from "../components/InboxZero.tsx";
import { Icon } from "../components/Icon.tsx";
import { Keys } from "../components/Keycap.tsx";
import { Link } from "../components/Link.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useNow } from "../lib/hooks.ts";
import { plural } from "../lib/format.ts";
import { acceptAll, backfillAutopilot, isProposal, needsYou, orderedItems, patchAutopilot, proposalCount, refreshAutopilot, runAutopilot, turnOn, useAutopilot } from "../store/autopilot.ts";
import { autopilotEngines, refreshEngines, useEngines } from "../store/engines.ts";
import type { AutopilotOverview } from "../types.ts";
import { DecisionRow } from "./autopilot/DecisionRow.tsx";
import { SidePanel } from "./autopilot/SidePanel.tsx";
import { Switch } from "./autopilot/Switch.tsx";

/** New mail, sorted as it arrives: what it decided, what needs you, and the rules behind it. */
export function AutopilotView() {
  const overview = useAutopilot((s) => s.overview);
  const error = useAutopilot((s) => s.error);

  useEffect(() => {
    refreshAutopilot(true);
    void refreshEngines();
  }, []);

  return (
    <section className="mail-pane" aria-label="Autopilot">
      <PageHeader title="Autopilot" />
      {!overview ? (
        error ? (
          <div className="state-block">
            <EmptyState title="Couldn't load Autopilot" hint={error} />
            <button className="btn" onClick={() => refreshAutopilot(true)}>
              Try again
            </button>
          </div>
        ) : (
          <div className="rv-skeleton ap-skeleton" aria-busy="true" aria-label="Loading Autopilot">
            <span />
            <span />
            <span />
          </div>
        )
      ) : (
        <Loaded overview={overview} />
      )}
    </section>
  );
}

/** The daily limit isn't a fault: it pauses until tomorrow by itself. */
const isPaused = (problem: string | null) => Boolean(problem && /^Autopilot paused until tomorrow/.test(problem));

function Loaded({ overview }: { overview: AutopilotOverview }) {
  const { settings, items, problem } = overview;
  const firstRun = !settings.enabled && items.length === 0;
  const paused = isPaused(problem);
  return (
    <>
      <ControlBar overview={overview} />
      {problem && settings.enabled && (paused ? (
        <div className="ap-problem calm" role="status">
          <Icon name="clock" size={16} />
          <span className="ap-problem-text">{problem}</span>
        </div>
      ) : (
        <div className="ap-problem" role="alert">
          <Icon name="alert" size={16} />
          <span className="ap-problem-text">{problem}</span>
          <Link to="/settings/models" className="btn btn-sm">
            Open Models &amp; accounts
          </Link>
        </div>
      ))}
      <div className="ap-scroll">
        <div className="ap-grid">
          <div className="ap-main">{firstRun ? <FirstRun overview={overview} /> : items.length === 0 ? <NothingYet overview={overview} /> : <Feed overview={overview} />}</div>
          <aside className="ap-side" aria-label="How Autopilot sorts">
            <SidePanel overview={overview} />
          </aside>
        </div>
      </div>
    </>
  );
}

// ---- Header controls --------------------------------------------------------------------------------

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function ControlBar({ overview }: { overview: AutopilotOverview }) {
  const { settings, running, problem, items } = overview;
  const engines = useEngines((s) => s.overview);
  const options = autopilotEngines(engines);
  const sortedToday = useMemo(() => items.filter((i) => i.stage === "decided" && (i.decidedAt ?? 0) >= startOfToday()).length, [items]);
  const waiting = proposalCount(overview);
  const modeHint = settings.mode === "suggest" ? "Decisions wait for you to accept them." : "Confident decisions are applied. You can undo any of them.";

  let status: React.ReactNode;
  if (!settings.enabled) status = <span className="ap-status-off">Off</span>;
  else if (isPaused(problem)) status = <span>Paused until tomorrow</span>;
  else if (problem) status = <span className="ap-status-bad">Needs attention</span>;
  else if (running) status = <span className="ap-status-live">Sorting new mail</span>;
  else if (sortedToday > 0) status = <span>Sorted {sortedToday} today{waiting > 0 ? ` · ${waiting} waiting for you` : ""}</span>;
  else status = <span>Watching for new mail</span>;

  return (
    <div className="ap-bar">
      <div className="ap-bar-in">
      <div className="ap-controls">
        <Switch checked={settings.enabled} label="Autopilot" onChange={(v) => void patchAutopilot({ enabled: v })} />
        <div className="seg" role="radiogroup" aria-label="What Autopilot does with its decisions">
          {(["suggest", "auto"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={settings.mode === m} className="seg-btn" onClick={() => settings.mode !== m && void patchAutopilot({ mode: m })}>
              {m === "suggest" ? "Suggest" : "Auto"}
            </button>
          ))}
        </div>
        <label className="ap-engine">
          <span className="sr-only">Model for Autopilot</span>
          <select
            className="select"
            value={settings.engine ?? ""}
            onChange={(e) => void patchAutopilot({ engine: (e.target.value || null) as AutopilotOverview["settings"]["engine"] })}
          >
            <option value="">Default{overview.engine ? ` (${overview.engine.label})` : ""}</option>
            {options.map((e) => (
              <option key={e.id} value={e.id} disabled={!e.ready && e.id !== settings.engine}>
                {e.label}
                {e.ready ? "" : " (not set up)"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="ap-statusline">
        <p className="ap-status" role="status">
          {status}
        </p>
        <span className="ap-mode-hint">{modeHint}</span>
        {settings.enabled && (
          <button className="btn btn-sm btn-quiet" disabled={running} onClick={() => void runAutopilot()}>
            Check now
          </button>
        )}
      </div>
      </div>
    </div>
  );
}

// ---- First run and empty --------------------------------------------------------------------------------

function noEngineNote(overview: AutopilotOverview) {
  return overview.engine === null ? (
    <p className="ap-first-note">
      Choose a model first. <Link to="/settings/models">Open Models &amp; accounts</Link>
    </p>
  ) : null;
}

function FirstRun({ overview }: { overview: AutopilotOverview }) {
  const ready = overview.engine !== null;
  return (
    <div className="ap-first">
      <p className="ap-first-lead">Sorts new mail as it arrives: what needs you stays, the rest is labelled and cleared, replies are drafted for you to send.</p>
      <p className="ap-first-sub">{overview.settings.mode === "suggest" ? "You'll see each decision first and accept the ones you agree with." : "Confident decisions are applied right away, and you can undo any of them."}</p>
      <div className="ap-first-actions">
        <button className="btn btn-primary" disabled={!ready} onClick={() => void turnOn()}>
          Turn on
        </button>
        <button className="btn" disabled={!ready} onClick={() => void turnOn(7)}>
          Also sort the last 7 days
        </button>
      </div>
      {noEngineNote(overview)}
    </div>
  );
}

function NothingYet({ overview }: { overview: AutopilotOverview }) {
  return (
    <div className="ap-first">
      <p className="ap-first-lead">Nothing sorted yet.</p>
      <p className="ap-first-sub">New mail shows up here as it arrives, with what Autopilot did and why.</p>
      <div className="ap-first-actions">
        <button className="btn" disabled={overview.running || overview.engine === null} onClick={() => void backfillAutopilot(7)}>
          Also sort the last 7 days
        </button>
      </div>
      {noEngineNote(overview)}
    </div>
  );
}

// ---- The feed -----------------------------------------------------------------------------------------------

function Feed({ overview }: { overview: AutopilotOverview }) {
  const now = useNow();
  const stored = useAutopilot((s) => s.focusedId);
  const rows = useMemo(() => orderedItems(overview.items), [overview.items]);
  const mine = rows.filter(needsYou);
  const rest = rows.filter((i) => !needsYou(i));
  const effective = rows.find((r) => r.id === stored)?.id ?? rows[0]?.id ?? null;
  const proposals = overview.items.filter(isProposal).length;
  const els = useRef(new Map<string, HTMLLIElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const prev = useRef<string | null>(null);

  // The keyboard moved the focus: bring the row into view and keep real focus on it.
  useEffect(() => {
    const before = prev.current;
    prev.current = effective;
    if (!before || !effective || before === effective) return;
    const el = els.current.get(effective);
    if (!el) return;
    const active = document.activeElement;
    if (!active || active === document.body || listRef.current?.contains(active)) el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  }, [effective]);

  const row = (i: (typeof rows)[number]) => (
    <DecisionRow
      key={i.id}
      item={i}
      now={now}
      focused={i.id === effective}
      register={(el) => (el ? els.current.set(i.id, el) : els.current.delete(i.id))}
    />
  );

  return (
    <div className="ap-feed" ref={listRef}>
      <div className="sr-only" role="status" aria-live="polite">
        {proposals > 0 ? `${plural(proposals, "suggestion")} waiting for you` : ""}
      </div>
      {proposals > 0 && (
        <div className="ap-proposals">
          <span>
            <b className="num">{proposals}</b> {proposals === 1 ? "suggestion is" : "suggestions are"} waiting for you.
          </span>
          <button className="btn btn-sm btn-primary" onClick={() => void acceptAll()}>
            Accept all <Keys binding="shift+a" />
          </button>
        </div>
      )}
      {mine.length > 0 && (
        <section className="ap-section" aria-labelledby="ap-needs">
          <h2 className="ap-section-title" id="ap-needs">
            Needs you <span className="num">{mine.length}</span>
          </h2>
          <ul className="ap-list" role="list">
            {mine.map(row)}
          </ul>
        </section>
      )}
      {rest.length > 0 && (
        <section className="ap-section" aria-labelledby="ap-sorted">
          <h2 className="ap-section-title" id="ap-sorted">
            Sorted <span className="num">{rest.length}</span>
          </h2>
          <ul className="ap-list" role="list">
            {rest.map(row)}
          </ul>
        </section>
      )}
      <p className="ap-keys" aria-hidden="true">
        <span>
          <Keys binding="j" /> <Keys binding="k" /> move
        </span>
        <span>
          <Keys binding="a" /> accept
        </span>
        <span>
          <Keys binding="d" /> dismiss
        </span>
        <span>
          <Keys binding="u" /> undo
        </span>
        <span>
          <Keys binding="enter" /> open
        </span>
      </p>
    </div>
  );
}

