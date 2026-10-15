import { useEffect, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { CloudSetup } from "../components/assistant/CloudForm.tsx";
import { Icon } from "../components/Icon.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { ago, agoShort, longTime } from "../lib/format.ts";
import { useNow } from "../lib/hooks.ts";
import { nextRunPhrase, STARTERS, triggerSummary, type Starter } from "../lib/routines.ts";
import { assistant, newChat, openAssistant } from "../store/assistant.ts";
import { dollars, deleteRoutine, loadHistory, modelName, refreshCloud, RUN_ACTIVE, runError, runRoutineNow, setRoutineEnabled, statusLabel, useCloud } from "../store/cloud.ts";
import { navigate } from "../store/route.ts";
import { toast } from "../store/toasts.ts";
import type { CloudRun, CloudStatus, Routine } from "../types.ts";
import { RoutineEditor } from "./agent/RoutineEditor.tsx";

/** The full-page home for what runs on its own, what Claude has done, and what it may spend. */
export function AgentView() {
  const status = useCloud((s) => s.status);
  const error = useCloud((s) => s.error);
  const connected = status?.connected === true;

  useEffect(() => {
    void refreshCloud();
  }, []);

  return (
    <section className="mail-pane" aria-label="Agent">
      <PageHeader title="Agent">{status && connected && <span className="cl-model cl-model-head">{modelName(status.model)}</span>}</PageHeader>
      {!status ? (
        error ? (
          <div className="state-block">
            <div className="empty">
              <div className="empty-title">Couldn't reach the cloud agent</div>
              <div className="empty-hint">{error}</div>
            </div>
            <button className="btn" onClick={() => void refreshCloud()}>
              Try again
            </button>
          </div>
        ) : (
          <div className="rv-skeleton" aria-busy="true" aria-label="Loading">
            <span />
            <span />
          </div>
        )
      ) : !connected ? (
        <div className="cl-page">
          <div className="cl-setup-wrap">
            <CloudSetup status={status} />
          </div>
        </div>
      ) : (
        <>
          <div className="cl-page">
            <div className="cl-grid">
              <Chats status={status} />
              <Routines status={status} />
            </div>
          </div>
          <Budget status={status} />
        </>
      )}
    </section>
  );
}

// ---- Chats ---------------------------------------------------------------------------------------

function Chats({ status }: { status: CloudStatus }) {
  const now = useNow();
  const [all, setAll] = useState(false);
  const runs = status.runs;
  const shown = all ? runs : runs.slice(0, 8);
  return (
    <section className="cl-block" aria-labelledby="cl-chats">
      <div className="cl-block-head">
        <h2 id="cl-chats">Chats</h2>
        <button className="btn btn-sm" onClick={() => (newChat(), openAssistant({ runId: null }))}>
          <Icon name="sparkle" size={14} /> Ask Claude
        </button>
      </div>
      {runs.length === 0 ? (
        <p className="cl-empty">Nothing yet. Ask Claude something from the sidebar and it shows up here.</p>
      ) : (
        <ul className="cl-runs" role="list">
          {shown.map((r) => (
            <RunRow key={r.id} run={r} agentId={status.agent?.id} now={now} />
          ))}
        </ul>
      )}
      {runs.length > 8 && !all && (
        <button
          className="btn btn-sm btn-quiet cl-more"
          onClick={() => {
            setAll(true);
            void loadHistory();
          }}
        >
          Show older chats
        </button>
      )}
    </section>
  );
}

function RunRow({ run, agentId, now }: { run: CloudRun; agentId: string | undefined; now: number }) {
  const active = RUN_ACTIVE.has(run.status);
  const bits = [
    run.toolCalls > 0 ? `${run.toolCalls} ${run.toolCalls === 1 ? "action" : "actions"}` : null,
    run.costCents !== null ? dollars(run.costCents) : null,
  ].filter(Boolean);
  return (
    <li className="cl-run">
      <span className={`as-dot as-${run.status}`} aria-hidden="true" />
      <div className="cl-run-main">
        <div className="cl-run-text">{run.instruction}</div>
        <div className="cl-run-meta">
          {active ? (
            <span className="cl-live">
              <span className="spinner" aria-hidden="true" /> {statusLabel(run.status)}
            </span>
          ) : run.status !== "done" ? (
            <span className={`as-state-tag as-${run.status}`}>{statusLabel(run.status)}</span>
          ) : null}
          {bits.length > 0 && <span className="num">{bits.join(" · ")}</span>}
          <time className="num" dateTime={new Date(run.createdAt).toISOString()} title={longTime(run.createdAt)}>
            {agoShort(run.createdAt, now)}
          </time>
        </div>
      </div>
      <div className="cl-run-actions">
        <button className="btn btn-sm" onClick={() => openAssistant({ runId: run.id })} aria-label={`Open the chat: ${run.instruction}`}>
          Open
        </button>
        {run.toolCalls > 0 && agentId && (
          <button className="btn btn-sm btn-quiet" onClick={() => navigate(`/activity?agent=${encodeURIComponent(agentId)}`)} aria-label="View activity">
            Activity
          </button>
        )}
      </div>
    </li>
  );
}

// ---- Routines --------------------------------------------------------------------------------------

type Editing = { kind: "new"; seed?: Starter["input"] } | { kind: "edit"; routine: Routine } | null;

function Routines({ status }: { status: CloudStatus }) {
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<Routine | null>(null);
  const routines = status.routines;
  return (
    <section className="cl-block" aria-labelledby="cl-routines">
      <div className="cl-block-head">
        <h2 id="cl-routines">Routines</h2>
        <button className="btn btn-sm" onClick={() => setEditing({ kind: "new" })}>
          <Icon name="plus" size={14} /> New routine
        </button>
      </div>
      {routines.length === 0 ? (
        <div className="cl-starters">
          <p className="cl-empty">Routines run Claude for you on a schedule, or when certain mail arrives. Start from one of these.</p>
          <ul role="list">
            {STARTERS.map((s) => (
              <li key={s.id}>
                <button className="cl-starter" onClick={() => setEditing({ kind: "new", seed: s.input })}>
                  <span className="cl-starter-name">{s.name}</span>
                  <span className="cl-starter-blurb">{s.blurb}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ul className="cl-routines" role="list">
          {routines.map((r) => (
            <RoutineRow key={r.id} r={r} onEdit={() => setEditing({ kind: "edit", routine: r })} onDelete={() => setRemoving(r)} />
          ))}
        </ul>
      )}
      {editing && <RoutineEditor routine={editing.kind === "edit" ? editing.routine : undefined} seed={editing.kind === "new" ? editing.seed : undefined} onClose={() => setEditing(null)} />}
      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.name}?`}
          confirmLabel="Delete routine"
          danger
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const r = removing;
            setRemoving(null);
            deleteRoutine(r.id).then(
              () => toast.info("Routine deleted"),
              (err: Error) => toast.error(err.message),
            );
          }}
        >
          It stops running. Chats it already started stay.
        </ConfirmDialog>
      )}
    </section>
  );
}

function RoutineRow({ r, onEdit, onDelete }: { r: Routine; onEdit: () => void; onDelete: () => void }) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = await runRoutineNow(r.id);
      openAssistant({ runId: run.id });
    } catch (err) {
      setError(runError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`cl-routine ${r.enabled ? "" : "off"}`}>
      <div className="cl-routine-head">
        <h3 className="cl-routine-name">{r.name}</h3>
        <button role="switch" aria-checked={r.enabled} aria-label={`${r.name} is ${r.enabled ? "on" : "off"}`} className="tgl" onClick={() => void setRoutineEnabled(r, !r.enabled)}>
          <span />
        </button>
      </div>
      <div className="cl-routine-when">{triggerSummary(r.trigger)}</div>
      <div className="cl-routine-meta">
        <span>{nextRunPhrase(r, now)}</span>
        <span aria-hidden="true">·</span>
        <span>{r.lastRunAt ? `Last ran ${ago(r.lastRunAt, now)}` : "Hasn't run yet"}</span>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="cl-routine-actions">
        <button className="btn btn-sm" disabled={busy} onClick={() => void runNow()} aria-label={`Run ${r.name} now`}>
          {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="zap" size={14} />} Run now
        </button>
        <button className="btn btn-sm" onClick={onEdit} aria-label={`Edit ${r.name}`}>
          Edit
        </button>
        <button className="btn btn-sm btn-danger" onClick={onDelete} aria-label={`Delete ${r.name}`}>
          Delete
        </button>
      </div>
    </li>
  );
}

// ---- Budget ----------------------------------------------------------------------------------------

function Budget({ status }: { status: CloudStatus }) {
  const spent = status.spentThisMonthCents;
  const cap = status.monthlyBudgetCents;
  const pct = Math.min(100, Math.round((spent / cap) * 100));
  const tone = spent >= cap ? "full" : pct >= 80 ? "high" : "";
  return (
    <footer className="cl-budget">
      <div className="cl-budget-main">
        <div className="cl-budget-line">
          <span className="num">
            {dollars(spent)} of {dollars(cap)} this month
          </span>
          {spent >= cap && <span className="cl-budget-note">New chats are paused.</span>}
        </div>
        <div className={`meter ${tone}`} role="meter" aria-label="Spent this month" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={Math.min(spent, cap)} aria-valuetext={`${dollars(spent)} of ${dollars(cap)}`}>
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
      <span className="cl-budget-run num">Up to {dollars(status.runBudgetCents)} a run</span>
      <button className="btn btn-sm btn-quiet" onClick={() => assistant.set({ accessOpen: true })}>
        Access and budgets
      </button>
    </footer>
  );
}
