import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api.ts";
import { AgentGlyph } from "../../components/AgentGlyph.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { CopyButton, Snippet } from "../../components/CopyBlock.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Icon } from "../../components/Icon.tsx";
import { claudeCodeCommand, curlCommand, stdioConfig } from "../../lib/connect.ts";
import { ago, listTime } from "../../lib/format.ts";
import { agentsUi } from "../../store/agents.ts";
import { useStore } from "../../store/createStore.ts";
import { toast } from "../../store/toasts.ts";
import type { AgentInfo, AgentPolicy, AgentScope, Webhook } from "../../types.ts";

export const SCOPE_INFO: { id: AgentScope; label: string; hint: string }[] = [
  { id: "read", label: "Read", hint: "Search and read mail, drafts and activity" },
  { id: "triage", label: "Triage", hint: "Mark done, star, label, remind, trash and unsubscribe" },
  { id: "draft", label: "Draft", hint: "Write and edit drafts and share with your team. Nothing is sent." },
  { id: "send", label: "Send", hint: "Send drafts as you, now or later" },
  { id: "settings", label: "Settings", hint: "Change your splits and add snippets" },
];

const DEFAULT_POLICY: AgentPolicy = { send: "always", bulkThreshold: 10, settings: "approve" };

function policyLines(a: AgentInfo): string[] {
  const out: string[] = [];
  if (a.scopes.includes("send")) out.push(a.policy.send === "always" ? "Asks before every send" : a.policy.send === "external" ? "Asks before sending outside your domain" : "Sends without asking");
  if (a.scopes.includes("triage")) out.push(`Asks before trashing more than ${a.policy.bulkThreshold}`);
  if (a.scopes.includes("settings")) out.push(a.policy.settings === "approve" ? "Asks before changing settings" : "Changes settings without asking");
  return out.length ? out : ["Nothing it does needs your approval"];
}

type Dialogs =
  | { kind: "form"; agent?: AgentInfo }
  | { kind: "token"; agent: AgentInfo; token: string }
  | { kind: "revoke"; agent: AgentInfo }
  | null;

export function AgentsSettings() {
  return (
    <div className="settings-list">
      <AgentsPanel />
      <WebhooksPanel />
    </div>
  );
}

function AgentsPanel() {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const createOpen = useStore(agentsUi, (s) => s.createOpen);

  const load = useCallback(() => {
    api
      .agents()
      .then((r) => (setAgents(r.agents), setError(null)))
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (!createOpen) return;
    agentsUi.set({ createOpen: false });
    setDialog({ kind: "form" });
  }, [createOpen]);

  return (
    <section className="panel-block" aria-label="Agents">
      <div className="ag-panel-head">
        <p className="block-lead">Assistants that work on your mail with their own token. Anything risky waits for you in Review.</p>
        <button className="btn btn-primary" onClick={() => setDialog({ kind: "form" })}>
          <Icon name="plus" /> New agent
        </button>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {agents === null && !error && (
        <div className="rv-skeleton ag-skeleton" aria-busy="true" aria-label="Loading agents">
          <span />
          <span />
        </div>
      )}
      {agents && agents.length === 0 && (
        <div className="ag-empty">
          <div className="empty-title">No agents yet</div>
          <div className="empty-hint">Create one to let Claude Code, Cursor or any MCP client read, triage and draft for you.</div>
        </div>
      )}
      {agents && agents.length > 0 && (
        <ul className="ag-list" role="list">
          {agents.map((a) => (
            <li key={a.id} className="ag-row">
              <AgentGlyph name={a.name} size={36} />
              <div className="ag-main">
                <div className="ag-name">{a.name}</div>
                <div className="ag-tags" aria-label="Access">
                  {a.scopes.map((s) => (
                    <span className="chip" key={s}>
                      {SCOPE_INFO.find((x) => x.id === s)?.label ?? s}
                    </span>
                  ))}
                </div>
                <div className="ag-meta">{policyLines(a).join(" · ")}</div>
                <div className="ag-meta num">
                  {a.lastUsedAt ? `Last used ${ago(a.lastUsedAt)}` : "Never used"} · Created {listTime(a.createdAt)} · Token ends in {a.tokenHint}
                </div>
              </div>
              <div className="ag-actions">
                <button className="btn btn-sm" onClick={() => setDialog({ kind: "form", agent: a })} aria-label={`Edit ${a.name}`}>
                  Edit
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => setDialog({ kind: "revoke", agent: a })} aria-label={`Revoke ${a.name}`}>
                  Revoke
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {dialog?.kind === "form" && (
        <AgentForm
          agent={dialog.agent}
          onClose={() => setDialog(null)}
          onSaved={(agent, token) => {
            load();
            if (token) setDialog({ kind: "token", agent, token });
            else {
              setDialog(null);
              toast.info("Saved");
            }
          }}
        />
      )}
      {dialog?.kind === "token" && <TokenDialog agent={dialog.agent} token={dialog.token} onClose={() => setDialog(null)} />}
      {dialog?.kind === "revoke" && <RevokeDialog agent={dialog.agent} onClose={() => setDialog(null)} onDone={() => (setDialog(null), load())} />}
    </section>
  );
}

function AgentForm({ agent, onClose, onSaved }: { agent?: AgentInfo; onClose: () => void; onSaved: (agent: AgentInfo, token?: string) => void }) {
  const [name, setName] = useState(agent?.name ?? "");
  const [scopes, setScopes] = useState<Set<AgentScope>>(new Set(agent?.scopes ?? ["read", "triage", "draft"]));
  const [policy, setPolicy] = useState<AgentPolicy>(agent?.policy ?? DEFAULT_POLICY);
  const [bulk, setBulk] = useState(String(agent?.policy.bulkThreshold ?? DEFAULT_POLICY.bulkThreshold));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useRef(Math.random().toString(36).slice(2)).current;

  const toggle = (s: AgentScope) =>
    setScopes((cur) => {
      const next = new Set(cur);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    const threshold = Number(bulk);
    if (!trimmed) return setError("Give the agent a name.");
    if (scopes.size === 0) return setError("Choose at least one thing it can do.");
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 10_000) return setError("Enter a number between 1 and 10,000.");
    setError(null);
    setBusy(true);
    const body = { name: trimmed, scopes: SCOPE_INFO.map((s) => s.id).filter((s) => scopes.has(s)), policy: { ...policy, bulkThreshold: threshold } };
    try {
      if (agent) onSaved((await api.updateAgent(agent.id, body)).agent);
      else {
        const res = await api.createAgent(body);
        onSaved(res.agent, res.token);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the agent");
      setBusy(false);
    }
  };

  return (
    <Dialog label={agent ? `Edit ${agent.name}` : "New agent"} onClose={onClose} className="dialog-agent" initialFocus="#ag-name">
      <form className="ag-form" onSubmit={submit} noValidate>
        <div className="dialog-head ag-head">
          <h3 aria-hidden="true">{agent ? "Edit agent" : "New agent"}</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ag-body">
          <label className="form-row">
            <span>Name</span>
            <input id="ag-name" className="field" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Claude Code" autoComplete="off" />
            <span className="form-hint">Shown in Review and Activity.</span>
          </label>
          <fieldset className="ag-set">
            <legend>What it can do</legend>
            {SCOPE_INFO.map((s) => (
              <label key={s.id} className="ag-check">
                <input type="checkbox" checked={scopes.has(s.id)} onChange={() => toggle(s.id)} />
                <span>
                  <span className="ag-check-title">{s.label}</span>
                  <span className="ag-check-hint">{s.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="ag-set">
            <legend>When it should ask you first</legend>
            <div className="ag-ask" aria-disabled={!scopes.has("send")}>
              <label htmlFor={`${id}-send`}>Sending mail</label>
              <select id={`${id}-send`} className="select" disabled={!scopes.has("send")} value={policy.send} onChange={(e) => setPolicy({ ...policy, send: e.target.value as AgentPolicy["send"] })}>
                <option value="always">Always ask</option>
                <option value="external">Ask when outside my domain</option>
                <option value="never">Never ask</option>
              </select>
            </div>
            <div className="ag-ask" aria-disabled={!scopes.has("triage")}>
              <label htmlFor={`${id}-bulk`}>Trashing or reporting spam on more than</label>
              <span className="ag-number">
                <input id={`${id}-bulk`} className="field num" inputMode="numeric" disabled={!scopes.has("triage")} value={bulk} onChange={(e) => setBulk(e.target.value.replace(/[^\d]/g, ""))} />
                <span>conversations</span>
              </span>
            </div>
            <div className="ag-ask" aria-disabled={!scopes.has("settings")}>
              <label htmlFor={`${id}-settings`}>Changing splits and snippets</label>
              <select id={`${id}-settings`} className="select" disabled={!scopes.has("settings")} value={policy.settings} onChange={(e) => setPolicy({ ...policy, settings: e.target.value as AgentPolicy["settings"] })}>
                <option value="approve">Ask</option>
                <option value="allow">Allow</option>
              </select>
            </div>
          </fieldset>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="ag-foot form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {agent ? "Save changes" : "Create agent"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Shows a secret once. Escape or Done asks for a copy first; a click outside never closes it. */
function RevealDialog({
  title,
  value,
  valueLabel,
  need,
  onClose,
  children,
}: {
  title: string;
  value: string;
  valueLabel: string;
  need: string;
  onClose: () => void;
  children?: (markCopied: () => void) => React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [warned, setWarned] = useState(false);
  const attempt = () => {
    if (copied || warned) return onClose();
    setWarned(true);
  };
  const nudge = warned && !copied;
  return (
    <Dialog label={title} onClose={attempt} className="dialog-agent" lockScrim initialFocus="[data-reveal]">
      <div className="ag-form">
        <div className="dialog-head ag-head">
          <h3 aria-hidden="true">{title}</h3>
        </div>
        <div className="ag-body">
          <p className="ag-once" data-warn={nudge ? "true" : undefined} role={nudge ? "alert" : undefined}>
            <strong>You won't see this again.</strong> {nudge ? `Copy the ${valueLabel} before you close this.` : `Copy the ${valueLabel} now. ${need}`}
          </p>
          <div className="copy-field">
            <input className="field num" readOnly value={value} aria-label={valueLabel[0]!.toUpperCase() + valueLabel.slice(1)} data-reveal onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
            <CopyButton text={value} what={valueLabel} onCopied={() => setCopied(true)} />
          </div>
          {children?.(() => setCopied(true))}
        </div>
        <div className="ag-foot form-actions">
          <button className="btn btn-primary" onClick={attempt}>
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function TokenDialog({ agent, token, onClose }: { agent: AgentInfo; token: string; onClose: () => void }) {
  const origin = location.origin;
  return (
    <RevealDialog title={`Token for ${agent.name}`} value={token} valueLabel="token" need={`${agent.name} needs it to connect.`} onClose={onClose}>
      {(markCopied) => (
        <div className="ag-snips">
          <Snippet title="Claude Code" text={claudeCodeCommand(origin, token)} onCopied={markCopied} />
          <Snippet title="Claude Desktop, Cursor and other stdio clients" hint="A local install creates its own token, so this needs none." text={stdioConfig} />
          <Snippet title="HTTP API" text={curlCommand(origin, token)} onCopied={markCopied} />
        </div>
      )}
    </RevealDialog>
  );
}

function RevokeDialog({ agent, onClose, onDone }: { agent: AgentInfo; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    setBusy(true);
    try {
      await api.revokeAgent(agent.id);
      toast.info(`Revoked ${agent.name}`);
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't revoke that agent");
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog title={`Revoke ${agent.name}?`} confirmLabel="Revoke access" danger busy={busy} onConfirm={() => void revoke()} onClose={onClose}>
      Its token stops working right away, and anything it has waiting in Review can no longer be approved.
    </ConfirmDialog>
  );
}

// ---- Webhooks ------------------------------------------------------------------

const EVENT_INFO: Record<string, string> = {
  threads: "Conversations changed",
  drafts: "A draft was sent or failed",
  activity: "Someone or something did an action",
  approval: "A request arrived or was decided",
  sync: "A mailbox finished syncing",
  import: "An archive import progressed",
};

function deliveryLine(w: Webhook): string {
  if (!w.lastDeliveryAt) return "No deliveries yet";
  return w.lastError ? `Last delivery failed (${w.lastError}) ${ago(w.lastDeliveryAt)}` : `Delivered ${ago(w.lastDeliveryAt)}`;
}

function WebhooksPanel() {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Webhook | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api
      .webhooks()
      .then((r) => {
        setHooks(r.webhooks);
        setEvents(r.events);
        setPicked((cur) => (cur.size === 0 ? new Set(r.events) : cur));
        setError(null);
      })
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return setFormError("Enter the address to send events to.");
    if (picked.size === 0) return setFormError("Choose at least one event.");
    setFormError(null);
    setBusy(true);
    try {
      const all = events.length > 0 && events.every((ev) => picked.has(ev));
      const res = await api.createWebhook(url.trim(), all ? ["*"] : events.filter((ev) => picked.has(ev)));
      setSecret(res.secret);
      setUrl("");
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Couldn't add the webhook");
    } finally {
      setBusy(false);
    }
  };

  const test = async (w: Webhook) => {
    setTests((t) => ({ ...t, [w.id]: "Sending…" }));
    try {
      const { status } = await api.testWebhook(w.id);
      const text = status === 0 ? "Couldn't connect" : status >= 200 && status < 300 ? `Delivered (${status})` : `Failed (HTTP ${status})`;
      setTests((t) => ({ ...t, [w.id]: text }));
    } catch (err) {
      setTests((t) => ({ ...t, [w.id]: err instanceof Error ? err.message : "The test didn't run" }));
    }
    load();
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await api.deleteWebhook(removing.id);
      toast.info("Webhook removed");
      setRemoving(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that webhook");
      setRemoving(null);
    }
  };

  return (
    <section className="panel-block" aria-label="Webhooks">
      <div>
        <h3 className="block-title">Webhooks</h3>
        <p className="block-lead">For assistants that would rather be told than ask. Each delivery is signed with the secret.</p>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {hooks && hooks.length > 0 && (
        <ul className="ag-list" role="list">
          {hooks.map((w) => (
            <li key={w.id} className="ag-row wh-row">
              <div className="ag-main">
                <div className="ag-name ellipsis" title={w.url}>
                  {w.url}
                </div>
                <div className="ag-tags" aria-label="Events">
                  {w.events.includes("*") ? (
                    <span className="chip">All events</span>
                  ) : (
                    w.events.map((ev) => (
                      <span className="chip" key={ev}>
                        {ev}
                      </span>
                    ))
                  )}
                </div>
                <div className={`ag-meta ${w.lastError ? "ag-meta-bad" : ""}`}>{deliveryLine(w)}</div>
                {tests[w.id] && (
                  <div className="ag-meta wh-test" role="status">
                    {tests[w.id]}
                  </div>
                )}
              </div>
              <div className="ag-actions">
                <button className="btn btn-sm" disabled={tests[w.id] === "Sending…"} onClick={() => void test(w)} aria-label={`Send a test to ${w.url}`}>
                  Test
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => setRemoving(w)} aria-label={`Remove ${w.url}`}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {hooks && hooks.length === 0 && <p className="ag-meta">No webhooks yet.</p>}
      <form className="wh-form" onSubmit={add} noValidate>
        <label className="form-row">
          <span>Address</span>
          <input className="field" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/slipstream" autoComplete="off" />
        </label>
        <fieldset className="ag-set wh-events">
          <legend>Send me</legend>
          <div className="wh-grid">
            {events.map((ev) => (
              <label key={ev} className="ag-check">
                <input
                  type="checkbox"
                  checked={picked.has(ev)}
                  onChange={() =>
                    setPicked((cur) => {
                      const next = new Set(cur);
                      if (next.has(ev)) next.delete(ev);
                      else next.add(ev);
                      return next;
                    })
                  }
                />
                <span>
                  <span className="ag-check-title">{ev}</span>
                  <span className="ag-check-hint">{EVENT_INFO[ev] ?? ""}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {formError && (
          <div className="form-error" role="alert">
            {formError}
          </div>
        )}
        <div className="form-actions start">
          <button className="btn" disabled={busy}>
            Add webhook
          </button>
        </div>
      </form>
      {secret && (
        <RevealDialog title="Webhook secret" value={secret} valueLabel="secret" need="Use it to check the signature on each delivery." onClose={() => setSecret(null)} />
      )}
      {removing && (
        <ConfirmDialog title="Remove this webhook?" confirmLabel="Remove" danger onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          Slipstream stops sending events to {removing.url}.
        </ConfirmDialog>
      )}
    </section>
  );
}
