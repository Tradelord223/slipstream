import { useId, useState } from "react";
import { SCOPE_INFO } from "../../lib/scopes.ts";
import { connectCloud, modelName } from "../../store/cloud.ts";
import { toast } from "../../store/toasts.ts";
import type { AgentScope, CloudStatus } from "../../types.ts";
import { Dialog } from "../Dialog.tsx";
import { Icon } from "../Icon.tsx";

const KEYS_URL = "https://console.anthropic.com/settings/keys";
const DEFAULT_SCOPES: AgentScope[] = ["read", "triage", "draft"];
const SEND_HINT = "Send drafts as you. Each send waits for your OK in Review.";

export function toDollars(cents: number) {
  return (cents / 100).toFixed(2);
}

export function parseMoney(v: string): number | null {
  const n = Number(v.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && v.trim() !== "" ? n : null;
}

export function Money({ id, value, onChange, label }: { id: string; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="form-row" htmlFor={id}>
      <span>{label}</span>
      <span className="money">
        <span aria-hidden="true">$</span>
        <input id={id} className="field num" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ""))} autoComplete="off" />
      </span>
    </label>
  );
}

/**
 * Link the account, or change what Claude can do and spend. The same fields serve the first setup (with the key)
 * and later edits (without it).
 */
export function CloudForm({ status, mode, onDone, onCancel }: { status: CloudStatus | null; mode: "setup" | "edit"; onDone: () => void; onCancel?: () => void }) {
  const id = useId();
  const [apiKey, setApiKey] = useState("");
  const [scopes, setScopes] = useState<Set<AgentScope>>(new Set(status?.agent?.scopes ?? DEFAULT_SCOPES));
  const [run, setRun] = useState(toDollars(status?.runBudgetCents ?? 100));
  const [month, setMonth] = useState(toDollars(status?.monthlyBudgetCents ?? 2000));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasKey = status?.hasKey === true;
  const options = SCOPE_INFO.filter((s) => s.id !== "settings" || status?.agent?.scopes.includes("settings"));

  const toggle = (s: AgentScope) =>
    setScopes((cur) => {
      const next = new Set(cur);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const perRun = parseMoney(run);
    const perMonth = parseMoney(month);
    if (mode === "setup" && !apiKey.trim() && !hasKey) return setError("Paste your Anthropic API key to connect.");
    if (scopes.size === 0) return setError("Choose at least one thing Claude can do.");
    if (perRun === null || perRun < 0.1 || perRun > 100) return setError("Each run can cost between $0.10 and $100.00.");
    if (perMonth === null || perMonth < 1 || perMonth > 10_000) return setError("The monthly budget can be between $1.00 and $10,000.00.");
    setError(null);
    setBusy(true);
    try {
      await connectCloud({
        apiKey: apiKey.trim() || undefined,
        scopes: SCOPE_INFO.map((s) => s.id).filter((s) => scopes.has(s)),
        // Sending always waits for a person, whatever the agent's earlier policy was.
        policy: mode === "setup" ? { send: "always" } : undefined,
        runBudgetCents: Math.round(perRun * 100),
        monthlyBudgetCents: Math.round(perMonth * 100),
      });
      toast.info(mode === "setup" ? "Claude is connected" : "Saved");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect. Try again.");
      setBusy(false);
    }
  };

  return (
    <form className="cl-form" onSubmit={submit} noValidate>
      {mode === "setup" && (
        <label className="form-row" htmlFor={`${id}-key`}>
          <span>Anthropic API key</span>
          <input
            id={`${id}-key`}
            className="field"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasKey ? "Using your saved key" : "sk-ant-…"}
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore
            aria-describedby={`${id}-key-hint`}
          />
          <span className="form-hint" id={`${id}-key-hint`}>
            {hasKey ? "Leave this empty to use the key you saved, or paste a new one. " : ""}
            <a href={KEYS_URL} target="_blank" rel="noopener noreferrer">
              Create a key in the Anthropic Console
            </a>
          </span>
        </label>
      )}
      <fieldset className="ag-set">
        <legend>What Claude can do</legend>
        {options.map((s) => (
          <label key={s.id} className="ag-check">
            <input type="checkbox" checked={scopes.has(s.id)} onChange={() => toggle(s.id)} />
            <span>
              <span className="ag-check-title">{s.label}</span>
              <span className="ag-check-hint">{s.id === "send" ? SEND_HINT : s.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="cl-money">
        <Money id={`${id}-run`} label="Most a single run can cost" value={run} onChange={setRun} />
        <Money id={`${id}-month`} label="Monthly budget" value={month} onChange={setMonth} />
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="cl-form-foot">
        <span className="cl-model">{modelName(status?.model ?? "claude-opus-5-5")}</span>
        <span className="grow" />
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn-primary" disabled={busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {mode === "setup" ? (busy ? "Connecting…" : "Connect") : busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

/** The first-run panel: what Claude does here, and the form to turn it on. */
export function CloudSetup({ status, onDone }: { status: CloudStatus | null; onDone?: () => void }) {
  return (
    <div className="cl-setup">
      <div className="cl-setup-head">
        <span className="cl-mark" aria-hidden="true">
          <Icon name="sparkle" size={18} />
        </span>
        <h2>Connect Claude</h2>
      </div>
      <p className="cl-setup-lead">Claude works in your inbox through Slipstream's own actions. Sending still waits for you in Review.</p>
      <CloudForm status={status} mode="setup" onDone={() => onDone?.()} />
    </div>
  );
}

/** Access and budgets for a connected agent. Opened from the panel, the Agent page and Settings. */
export function CloudAccessDialog({ status, onClose }: { status: CloudStatus; onClose: () => void }) {
  return (
    <Dialog label="Claude access and budgets" onClose={onClose} className="dialog-agent" initialFocus="input">
      <div className="ag-form">
        <div className="dialog-head ag-head">
          <h3 aria-hidden="true">Access and budgets</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ag-body">
          <CloudForm status={status} mode="edit" onDone={onClose} onCancel={onClose} />
        </div>
      </div>
    </Dialog>
  );
}

/** Connect the managed cloud agent from Models & accounts: the same form as first-run setup, in a dialog. */
export function CloudConnectDialog({ status, onDone, onClose }: { status: CloudStatus | null; onDone: () => void; onClose: () => void }) {
  return (
    <Dialog label="Connect Claude (cloud)" onClose={onClose} className="dialog-agent" initialFocus="input[type=password]">
      <div className="ag-form">
        <div className="dialog-head ag-head">
          <h3 aria-hidden="true">Connect Claude (cloud)</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ag-body">
          <p className="cl-setup-lead">Claude works in your inbox through Slipstream's own actions. Sending still waits for you in Review.</p>
          <CloudForm status={status} mode="setup" onDone={onDone} onCancel={onClose} />
        </div>
      </div>
    </Dialog>
  );
}
