import { Fragment, useEffect, useId, useRef, useState } from "react";
import { api, ApiError } from "../../api.ts";
import { CloudConnectDialog, Money, parseMoney, toDollars } from "../../components/assistant/CloudForm.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Icon } from "../../components/Icon.tsx";
import { ENGINE_GROUPS, KEY_LINKS, KEY_PROVIDER, shortModel } from "../../lib/engines.ts";
import { dollars, refreshCloud, useCloud } from "../../store/cloud.ts";
import { chooseEngine, chooseModel, refreshEngines, saveBudgets, setOverview, useEngines } from "../../store/engines.ts";
import { session, updateSettings, useSession } from "../../store/session.ts";
import { toast } from "../../store/toasts.ts";
import type { EngineStatus, EnginesOverview, KeyProvider } from "../../types.ts";
import { ManagedActions, ManagedDetails } from "./CloudCard.tsx";

const GROUP_HINT: Record<string, string> = {
  plans: "Use a subscription you already pay for.",
  keys: "Pay as you go, billed by the provider.",
  managed: "Runs in Anthropic's cloud with its own limits.",
};

/** Settings → Models & accounts: what your agents run on, who pays, and how much they may spend. */
export function ModelsSettings() {
  const overview = useEngines((s) => s.overview);
  const error = useEngines((s) => s.error);

  useEffect(() => {
    void refreshEngines();
    void refreshCloud();
  }, []);

  if (!overview) {
    return error ? (
      <div className="panel-block eng-error" role="alert">
        <div className="empty-title">Couldn't load your models</div>
        <p className="block-lead">{error}</p>
        <button className="btn align-start" onClick={() => void refreshEngines()}>
          Try again
        </button>
      </div>
    ) : (
      <div className="rv-skeleton eng-skeleton" aria-busy="true" aria-label="Loading models">
        <span />
        <span />
        <span />
      </div>
    );
  }

  return (
    <div className="settings-list eng-page">
      <p className="block-lead eng-lead">
        Choose what your agents think with. Whichever you pick, they only do what your permissions allow, and sending waits for you in Review.
      </p>
      <AssistantOffNotice overview={overview} />
      {ENGINE_GROUPS.map((g) => {
        const list = g.ids.map((id) => overview.engines.find((e) => e.id === id)).filter((e): e is EngineStatus => Boolean(e));
        if (list.length === 0) return null;
        return (
          <section key={g.id} className="eng-group" aria-labelledby={`eng-g-${g.id}`}>
            <div className="eng-group-head">
              <h3 id={`eng-g-${g.id}`} className="eng-group-title">
                {g.title}
              </h3>
              <span className="eng-group-hint">{GROUP_HINT[g.id]}</span>
            </div>
            <ul className="eng-list" role="list">
              {list.map((e) => (
                <li key={e.id}>
                  <EngineCard engine={e} overview={overview} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <Budgets overview={overview} />
    </div>
  );
}

/** With a model ready and the built-in assistant off, the one step that's left is right here. */
function AssistantOffNotice({ overview }: { overview: EnginesOverview }) {
  const off = useSession((s) => s.settings.assistant === "off");
  const [busy, setBusy] = useState(false);
  if (!off || !overview.engines.some((e) => e.ready)) return null;
  const turnOn = async () => {
    setBusy(true);
    await updateSettings({ assistant: "on" });
    setBusy(false);
    if (session.get().settings.assistant === "on") toast.info("The assistant is on");
  };
  return (
    <div className="notice-row" role="status">
      <Icon name="sparkle" />
      <span className="notice-text">A model is ready, but the built-in assistant is off.</span>
      <button className="btn btn-sm btn-primary" onClick={() => void turnOn()} disabled={busy}>
        Turn on the assistant
      </button>
    </div>
  );
}

// ---- One engine ---------------------------------------------------------------------------------

const URL_RE = /(https?:\/\/[^\s)]+[^\s.,;:)])/g;

/** Notes carry the terms and billing words, sometimes with a link. */
function Linked({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer">
            {p.replace(/^https?:\/\//, "")}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function EngineCard({ engine, overview }: { engine: EngineStatus; overview: EnginesOverview }) {
  const isDefault = overview.defaultEngine === engine.id;
  if (engine.id === "loop:chatgpt") return <ChatGPTCard engine={engine} isDefault={isDefault} />;
  if (engine.kind === "managed") return <ManagedCard engine={engine} isDefault={isDefault} />;
  if (engine.kind === "cli") return <CliCard engine={engine} isDefault={isDefault} />;
  const provider = KEY_PROVIDER[engine.id as keyof typeof KEY_PROVIDER];
  return <KeyCard engine={engine} isDefault={isDefault} provider={provider} source={overview.keys[provider]} />;
}

/** The shared shape of every engine: status, its one primary action, model and default, then the small print. */
function EngineFrame({
  engine,
  isDefault,
  detail = engine.detail,
  actions,
  children,
  modelPicker = true,
}: {
  engine: EngineStatus;
  isDefault: boolean;
  detail?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  modelPicker?: boolean;
}) {
  const titleId = useId();
  return (
    <article className="eng" data-ready={engine.ready ? "true" : "false"} aria-labelledby={titleId}>
      <header className="eng-head">
        <span className={`eng-dot ${engine.ready ? "ready" : ""}`} aria-hidden="true" />
        <h4 className="eng-name" id={titleId}>
          {engine.label}
        </h4>
        <span className="chip eng-tag" title={engine.billing === "plan" ? "Uses your plan's own limits" : "Billed per use by the provider"}>
          {engine.billing === "plan" ? "Plan" : "API"}
        </span>
        {isDefault && <span className="chip chip-accent">Default</span>}
        <span className="grow" />
        {actions && <div className="eng-actions">{actions}</div>}
      </header>
      {detail && (
        <p className="eng-detail">
          <span className="sr-only">{engine.ready ? "Ready. " : "Not ready. "}</span>
          {detail}
        </p>
      )}
      {children}
      {engine.ready && (
        <div className="eng-foot">
          {modelPicker && <ModelPicker engine={engine} />}
          <button className="btn btn-sm eng-default" disabled={isDefault} aria-pressed={isDefault} onClick={() => void run(() => chooseEngine(engine.id))}>
            {isDefault ? (
              <>
                <Icon name="check" size={14} /> Default
              </>
            ) : (
              "Use by default"
            )}
          </button>
        </div>
      )}
      {engine.note && (
        <p className="eng-note">
          <Linked text={engine.note} />
        </p>
      )}
    </article>
  );
}

function CliCard({ engine, isDefault }: { engine: EngineStatus; isDefault: boolean }) {
  const [checking, setChecking] = useState(false);
  return (
    <EngineFrame
      engine={engine}
      isDefault={isDefault}
      actions={
        !engine.ready && (
          <button
            className="btn btn-sm"
            disabled={checking}
            onClick={() => {
              setChecking(true);
              void refreshEngines().finally(() => setChecking(false));
            }}
          >
            Check again
          </button>
        )
      }
    />
  );
}

/** Claude on Anthropic's Managed Agents: its connect flow and access settings live here now. */
function ManagedCard({ engine, isDefault }: { engine: EngineStatus; isDefault: boolean }) {
  const status = useCloud((s) => s.status);
  const [connecting, setConnecting] = useState(false);
  const connected = status?.connected === true;
  return (
    <EngineFrame
      engine={engine}
      isDefault={isDefault}
      modelPicker={false}
      actions={
        connected ? (
          <ManagedActions />
        ) : (
          <button className="btn btn-sm btn-primary" onClick={() => setConnecting(true)}>
            Connect
          </button>
        )
      }
    >
      {connected && status && <ManagedDetails status={status} />}
      {connecting && (
        <CloudConnectDialog
          status={status}
          onClose={() => setConnecting(false)}
          onDone={() => {
            setConnecting(false);
            void refreshEngines();
          }}
        />
      )}
    </EngineFrame>
  );
}

async function run(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "That didn't save");
  }
}

function ModelPicker({ engine }: { engine: EngineStatus }) {
  const id = useId();
  const models = engine.models ?? [];
  const [busy, setBusy] = useState(false);
  if (engine.kind === "managed" || (!engine.model && models.length === 0)) return null;
  if (models.length === 0) {
    return (
      <div className="eng-model">
        <span className="eng-model-label">Model</span>
        <span className="eng-model-fixed">{shortModel(engine.model)}</span>
      </div>
    );
  }
  const list = engine.model && !models.includes(engine.model) ? [engine.model, ...models] : models;
  return (
    <label className="eng-model" htmlFor={id}>
      <span className="eng-model-label">Model</span>
      <select
        id={id}
        className="select"
        value={engine.model ?? list[0]}
        disabled={busy}
        onChange={(e) => {
          setBusy(true);
          void run(() => chooseModel(engine.id, e.target.value)).finally(() => setBusy(false));
        }}
      >
        {list.map((m) => (
          <option key={m} value={m}>
            {shortModel(m)}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---- API keys ------------------------------------------------------------------------------------

/** An API key engine: Add, Replace or Remove, with a password field that opens under the status line. */
function KeyCard({ engine, isDefault, provider, source }: { engine: EngineStatus; isDefault: boolean; provider: KeyProvider; source: "saved" | "environment" | null }) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      setOverview(await api.removeEngineKey(provider));
      void refreshCloud();
      toast.info(`${engine.label} key removed`);
      setRemoving(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <EngineFrame
      engine={engine}
      isDefault={isDefault}
      actions={
        !editing &&
        (source === null ? (
          <button className="btn btn-sm btn-primary" onClick={() => setEditing(true)} aria-label={`Add ${engine.label} key`}>
            Add key
          </button>
        ) : (
          <>
            <button className="btn btn-sm" onClick={() => setEditing(true)} aria-label={`Replace ${engine.label} key`}>
              Replace
            </button>
            {source === "saved" && (
              <button className="btn btn-sm btn-danger" onClick={() => setRemoving(true)} aria-label={`Remove ${engine.label} key`}>
                Remove
              </button>
            )}
          </>
        ))
      }
    >
      {source && !editing && (
        <p className="eng-key">
          <Icon name="shield" size={13} />
          {source === "environment" ? "From the server's environment" : "Saved on this server"}
        </p>
      )}
      {editing && <KeyForm provider={provider} engine={engine} source={source} onClose={() => setEditing(false)} />}
      {removing && (
        <ConfirmDialog title={`Remove the ${engine.label} key?`} confirmLabel="Remove key" danger busy={busy} onConfirm={() => void remove()} onClose={() => setRemoving(false)}>
          Agents can't use {engine.label} until you add a key again.
          {provider === "anthropic" ? " Claude (cloud) uses this key too, so it stops working as well." : ""}
        </ConfirmDialog>
      )}
    </EngineFrame>
  );
}

function KeyForm({ provider, engine, source, onClose }: { provider: KeyProvider; engine: EngineStatus; source: "saved" | "environment" | null; onClose: () => void }) {
  const id = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const link = KEY_LINKS[provider]!;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (key.length < 8) return setError("Paste the whole key.");
    setBusy(true);
    setError(null);
    try {
      setOverview(await api.saveEngineKey(provider, key));
      void refreshCloud();
      toast.info(`${engine.label} key saved`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the key");
      setBusy(false);
    }
  };

  return (
    <form className="eng-keyform" onSubmit={submit} noValidate>
      <label className="form-row" htmlFor={id}>
        <span>{engine.label} key</span>
        <input
          id={id}
          className="field"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={link.placeholder}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          data-1p-ignore
          aria-describedby={`${id}-hint`}
        />
        <span className="form-hint" id={`${id}-hint`}>
          {source === "environment" ? "This replaces the key from the server's environment. " : ""}
          <a href={link.url} target="_blank" rel="noopener noreferrer">
            Create a key at {link.name}
          </a>
        </span>
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions start">
        <button className="btn btn-sm btn-primary" disabled={busy}>
          {busy ? "Saving…" : "Save key"}
        </button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---- ChatGPT sign-in -----------------------------------------------------------------------------------

const PASTE_PREFIX = "http://127.0.0.1:1455/auth/callback?";

type Flow = { phase: "idle" } | { phase: "starting" } | { phase: "loopback" | "paste" | "completing"; url: string };

function ChatGPTCard({ engine, isDefault }: { engine: EngineStatus; isDefault: boolean }) {
  const [flow, setFlow] = useState<Flow>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const id = useId();
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);

  const idleDetail = useRef(engine.detail);
  const begin = async () => {
    idleDetail.current = engine.detail;
    setNotice(null);
    setError(null);
    setFlow({ phase: "starting" });
    try {
      const res = await api.chatgptSignIn();
      // The person's own browser opens only once the server has the sign-in ready.
      window.open(res.authorizeUrl, "_blank", "noopener,noreferrer");
      setFlow({ phase: res.mode, url: res.authorizeUrl });
    } catch (err) {
      setFlow({ phase: "idle" });
      setError(err instanceof Error ? err.message : "Couldn't start signing in");
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      const { revoked, ...overview } = await api.chatgptSignOut();
      setOverview(overview);
      if (revoked) toast.info("Signed out of ChatGPT");
      else setNotice("We couldn't confirm OpenAI revoked access. You can disconnect Slipstream in ChatGPT Settings.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't sign out");
    } finally {
      setSigningOut(false);
    }
  };

  // Loopback: the browser tab finishes by itself, so ask the server every couple of seconds.
  const waiting = flow.phase === "loopback";
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    let stopped = false;
    const tick = async () => {
      try {
        const o = await api.engines();
        if (stopped) return;
        setOverview(o);
        const g = o.engines.find((e) => e.id === "loop:chatgpt");
        if (g?.ready) {
          setFlow({ phase: "idle" });
          toast.info("ChatGPT is connected");
          return;
        }
        if (g && !g.pending) {
          // Not waiting any more and not signed in: it lapsed, or the server says why it failed.
          setFlow({ phase: "idle" });
          setError(g.detail !== idleDetail.current ? g.detail : "Signing in didn't finish. Try again.");
          return;
        }
        if (Date.now() - started > 10 * 60_000) {
          setFlow({ phase: "idle" });
          setError("Signing in took too long. Try again.");
        }
      } catch {
        /* keep waiting */
      }
    };
    const t = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [waiting]);

  const complete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (flow.phase !== "paste") return;
    const url = pasted.trim();
    if (!url.startsWith(PASTE_PREFIX)) return setPasteError(`Paste the whole address. It starts with ${PASTE_PREFIX}`);
    setPasteError(null);
    setFlow({ phase: "completing", url: flow.url });
    try {
      setOverview(await api.chatgptComplete(url));
      setPasted("");
      setFlow({ phase: "idle" });
      toast.info("ChatGPT is connected");
    } catch (err) {
      setFlow({ phase: "paste", url: flow.url });
      setPasteError(err instanceof Error ? err.message : "That didn't work. Try signing in again.");
    }
  };

  const cancel = () => {
    setFlow({ phase: "idle" });
    setPasted("");
    setPasteError(null);
  };

  return (
    <EngineFrame
      engine={engine}
      isDefault={isDefault}
      // While signing in, the steps below say it all.
      detail={flow.phase === "idle" ? engine.detail : ""}
      actions={
        engine.ready ? (
          <button className="btn btn-sm" disabled={signingOut} onClick={() => void signOut()}>
            Sign out
          </button>
        ) : (
          flow.phase === "idle" && (
            <button className="btn btn-sm btn-primary" onClick={() => void begin()}>
              Continue with ChatGPT
            </button>
          )
        )
      }
    >
      {error && !engine.ready && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="eng-warn" role="status">
          <Icon name="alert" size={14} />
          {notice}
        </div>
      )}
      {flow.phase === "starting" && (
        <p className="eng-pending" role="status">
          <span className="eng-pending-dot" aria-hidden="true" /> Getting the sign-in page ready…
        </p>
      )}
      {flow.phase === "loopback" && (
        <div className="eng-pending" role="status">
          <span className="eng-pending-dot" aria-hidden="true" />
          <span className="eng-pending-text">
            Finish signing in in the tab that opened. You can close it afterwards.{" "}
            <a href={flow.url} target="_blank" rel="noopener noreferrer">
              Open it again
            </a>
          </span>
          <button className="btn btn-sm btn-quiet" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
      {(flow.phase === "paste" || flow.phase === "completing") && (
        <form className="eng-paste" onSubmit={complete} noValidate>
          <ol className="eng-steps">
            <li>
              Sign in with ChatGPT in the tab that opened.{" "}
              <a href={flow.url} target="_blank" rel="noopener noreferrer">
                Open it again
              </a>
            </li>
            <li>
              The page that comes next won't load. Copy the whole address from the address bar. It starts with <code>{PASTE_PREFIX}</code>
            </li>
            <li>Paste it here within 10 minutes.</li>
          </ol>
          <label className="form-row" htmlFor={id}>
            <span className="sr-only">Address from the address bar</span>
            <input
              id={id}
              className="field"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder={`${PASTE_PREFIX}code=…`}
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore
            />
          </label>
          {pasteError && (
            <div className="form-error" role="alert">
              {pasteError}
            </div>
          )}
          <div className="form-actions start">
            <button className="btn btn-sm btn-primary" disabled={flow.phase === "completing"}>
              {flow.phase === "completing" ? "Finishing…" : "Finish signing in"}
            </button>
            <button type="button" className="btn btn-sm btn-quiet" onClick={cancel}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </EngineFrame>
  );
}

// ---- Budgets ----------------------------------------------------------------------------------------------

function Budgets({ overview }: { overview: EnginesOverview }) {
  const id = useId();
  const spent = useCloud((s) => s.status?.spentThisMonthCents ?? null);
  const { runBudgetCents, monthlyBudgetCents } = overview.budgets;
  const [run, setRun] = useState(toDollars(runBudgetCents));
  const [month, setMonth] = useState(toDollars(monthlyBudgetCents));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = run !== toDollars(runBudgetCents) || month !== toDollars(monthlyBudgetCents);

  // Follow the server when the numbers change elsewhere (the managed agent's own dialog).
  useEffect(() => {
    setRun(toDollars(runBudgetCents));
    setMonth(toDollars(monthlyBudgetCents));
  }, [runBudgetCents, monthlyBudgetCents]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const perRun = parseMoney(run);
    const perMonth = parseMoney(month);
    if (perRun === null || perRun < 0.1 || perRun > 100) return setError("Each run can cost between $0.10 and $100.00.");
    if (perMonth === null || perMonth < 1 || perMonth > 10_000) return setError("The monthly budget can be between $1.00 and $10,000.00.");
    setError(null);
    setBusy(true);
    try {
      await saveBudgets({ runBudgetCents: Math.round(perRun * 100), monthlyBudgetCents: Math.round(perMonth * 100) });
      toast.info("Budgets saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the budgets");
    } finally {
      setBusy(false);
    }
  };

  const pct = spent === null ? 0 : Math.min(100, Math.round((spent / monthlyBudgetCents) * 100));
  const tone = spent !== null && spent >= monthlyBudgetCents ? "full" : pct >= 80 ? "high" : "";

  return (
    <section className="panel-block eng-budgets" aria-labelledby={`${id}-t`}>
      <div>
        <h3 className="block-title" id={`${id}-t`}>
          Spending limits
        </h3>
        <p className="block-lead">These dollar budgets apply to Claude (cloud) and OpenRouter. Every other API engine stops each run at 1.5 million tokens, and plans use their own limits.</p>
      </div>
      <form className="eng-budget-form" onSubmit={submit} noValidate>
        <Money id={`${id}-run`} label="Most a single run can cost" value={run} onChange={setRun} />
        <Money id={`${id}-month`} label="Monthly budget" value={month} onChange={setMonth} />
        <button className="btn btn-primary" disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {spent !== null && (
        <div className="eng-spent">
          <span className="num">
            {dollars(spent)} of {dollars(monthlyBudgetCents)} this month
          </span>
          <div className={`meter ${tone}`} role="meter" aria-label="Spent this month" aria-valuemin={0} aria-valuemax={monthlyBudgetCents} aria-valuenow={Math.min(spent, monthlyBudgetCents)} aria-valuetext={`${dollars(spent)} of ${dollars(monthlyBudgetCents)}`}>
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
    </section>
  );
}
