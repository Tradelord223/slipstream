import { useEffect, useRef, useState } from "react";
import { api } from "../../api.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Icon } from "../../components/Icon.tsx";
import { RichBox } from "../../components/RichBox.tsx";
import { ago } from "../../lib/format.ts";
import { useNow } from "../../lib/hooks.ts";
import { refreshCounts } from "../../store/counts.ts";
import { useImportJob, importState } from "../../store/events.ts";
import { reload } from "../../store/list.ts";
import { refreshSession, useSession } from "../../store/session.ts";
import { toast } from "../../store/toasts.ts";
import type { Account, Identity } from "../../types.ts";

const PROVIDER: Record<string, string> = { demo: "Demo mailbox", gmail: "Gmail", outlook: "Outlook", imap: "IMAP", archive: "Imported archive" };

export function AccountsSettings() {
  const accounts = useSession((s) => s.accounts);
  return (
    <div className="settings-list">
      <section className="panel-block" aria-label="Connected accounts">
        <ul className="account-list" role="list">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} />
          ))}
          {accounts.length === 0 && <li className="muted account-empty">No accounts yet. Connect one below.</li>}
        </ul>
      </section>
      <Connect />
      <ImapForm />
      <ImportBox />
    </div>
  );
}

function AccountRow({ account: a }: { account: Account }) {
  const now = useNow();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const status =
    a.syncStatus === "reauth" ? { text: "Needs to reconnect", tone: "warn" }
    : a.syncStatus === "error" ? { text: a.syncError ? `Sync problem: ${a.syncError}` : "Sync problem", tone: "bad" }
    : a.syncStatus === "syncing" ? { text: "Syncing…", tone: "muted" }
    : { text: `Synced ${ago(a.lastSyncedAt, now)}`, tone: "muted" };

  const sync = async () => {
    setBusy(true);
    try {
      await api.syncAccount(a.id);
      toast.info("Syncing");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start a sync");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await api.removeAccount(a.id);
      await refreshSession();
      reload(true);
      refreshCounts(true);
      toast.info(`Removed ${a.email}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that account");
    }
    setConfirm(false);
  };

  return (
    <li className="account-item">
      <div className="account-row">
        <span className="dot dot-lg" style={{ background: a.color }} />
        <span className="account-main">
          <span className="account-email">{a.email}</span>
          <span className="account-meta">
            {PROVIDER[a.provider] ?? a.provider}
            {a.name ? ` · ${a.name}` : ""}
          </span>
        </span>
        <span className={`account-status tone-${status.tone}`} role="status">
          {status.text}
        </span>
        <button className="btn btn-sm" onClick={() => void sync()} disabled={busy}>
          <Icon name="refresh" /> Sync now
        </button>
        <button className="btn btn-sm btn-danger" onClick={() => setConfirm(true)}>
          Remove
        </button>
        {confirm && (
          <Dialog label={`Remove ${a.email}`} onClose={() => setConfirm(false)} className="dialog-narrow">
            <div className="dialog-head">
              <h3>Remove {a.email}?</h3>
            </div>
            <p className="dialog-copy">Its mail is deleted from Slipstream. Your mail at the provider stays where it is.</p>
            <div className="form-actions">
              <button className="btn btn-quiet" onClick={() => setConfirm(false)}>
                Keep it
              </button>
              <button className="btn btn-danger" onClick={() => void remove()} autoFocus>
                Remove account
              </button>
            </div>
          </Dialog>
        )}
      </div>
      {/* Imported files can't send, so they have no other addresses to manage. */}
      {a.provider !== "archive" && <Identities account={a} />}
    </li>
  );
}

function Connect() {
  const features = useSession((s) => s.features);
  const [guide, setGuide] = useState<"google" | "microsoft" | null>(null);
  const port = location.port || "4380";
  const origin = location.origin;

  const go = (provider: "google" | "microsoft") => {
    if (features[provider]) window.location.href = `/api/oauth/${provider}/start`;
    else setGuide(guide === provider ? null : provider);
  };

  return (
    <section className="panel-block" aria-label="Connect an account">
      <h3 className="block-title">Connect an account</h3>
      <div className="connect-row">
        <button className="btn" onClick={() => go("google")} aria-expanded={features.google ? undefined : guide === "google"}>
          <Icon name="mail" /> Connect Gmail
        </button>
        <button className="btn" onClick={() => go("microsoft")} aria-expanded={features.microsoft ? undefined : guide === "microsoft"}>
          <Icon name="mail" /> Connect Outlook
        </button>
      </div>
      {guide === "google" && (
        <div className="guide" role="region" aria-label="Gmail setup">
          <p>Gmail needs a Google OAuth client of your own. Create one in the Google Cloud console, then start Slipstream with:</p>
          <pre>
            {`GOOGLE_CLIENT_ID=<your client id>\nGOOGLE_CLIENT_SECRET=<your client secret>`}
          </pre>
          <p>
            Set the authorized redirect URI to <code>{origin}/api/oauth/google/callback</code>. Full steps are in <a href="https://github.com/Tradelord223/slipstream/blob/main/docs/connect-accounts.md" target="_blank" rel="noopener noreferrer">the connection guide</a>.
          </p>
        </div>
      )}
      {guide === "microsoft" && (
        <div className="guide" role="region" aria-label="Outlook setup">
          <p>Outlook needs an app registration of your own in Microsoft Entra. Start Slipstream with:</p>
          <pre>{`MICROSOFT_CLIENT_ID=<your application id>`}</pre>
          <p>
            Set the redirect URI to <code>http://localhost:{port}/api/oauth/microsoft/callback</code> when running locally. Full steps are in <a href="https://github.com/Tradelord223/slipstream/blob/main/docs/connect-accounts.md" target="_blank" rel="noopener noreferrer">the connection guide</a>.
          </p>
        </div>
      )}
    </section>
  );
}

function ImapForm() {
  const [presets, setPresets] = useState<{ id: string; label: string; help: string }[]>([]);
  const [preset, setPreset] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .presets()
      .then((r) => setPresets(r.presets))
      .catch(() => undefined);
  }, []);

  const chosen = presets.find((p) => p.id === preset);
  const manual = !preset || preset === "custom" || advanced;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { email: email.trim(), name: name.trim(), password };
      if (preset) body.preset = preset;
      if (manual && imapHost) {
        body.imapHost = imapHost.trim();
        body.imapPort = Number(imapPort) || 993;
        body.smtpHost = smtpHost.trim();
        body.smtpPort = Number(smtpPort) || 465;
        body.imapSecure = Number(imapPort) !== 143;
        body.smtpSecure = Number(smtpPort) !== 587;
      }
      await api.connectImap(body);
      await refreshSession();
      toast.info(`Connected ${email.trim()}`);
      setEmail("");
      setPassword("");
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't connect that account");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel-block" aria-label="Connect another mail server">
      <h3 className="block-title">Connect another mail server</h3>
      <form className="imap-form" onSubmit={submit}>
        <label className="form-row">
          <span>Provider</span>
          <select className="select" value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="">Other (enter server names)</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {chosen?.help && <small className="form-hint">{chosen.help}</small>}
        </label>
        <div className="form-grid">
          <label className="form-row">
            <span>Email address</span>
            <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
          </label>
          <label className="form-row">
            <span>Your name</span>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </label>
        </div>
        <label className="form-row">
          <span>Password</span>
          <input className="field" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        </label>
        {preset && preset !== "custom" && (
          <button type="button" className="link-btn align-start" onClick={() => setAdvanced((a) => !a)} aria-expanded={advanced}>
            {advanced ? "Hide server settings" : "Server settings"}
          </button>
        )}
        {manual && (
          <div className="form-grid four">
            <label className="form-row">
              <span>IMAP server</span>
              <input className="field" value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="imap.example.com" />
            </label>
            <label className="form-row">
              <span>Port</span>
              <input className="field num" value={imapPort} onChange={(e) => setImapPort(e.target.value)} inputMode="numeric" />
            </label>
            <label className="form-row">
              <span>SMTP server</span>
              <input className="field" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" />
            </label>
            <label className="form-row">
              <span>Port</span>
              <input className="field num" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} inputMode="numeric" />
            </label>
          </div>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="form-actions start">
          <button className="btn btn-primary" disabled={busy || !email || !password}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </form>
    </section>
  );
}

function ImportBox() {
  const job = useImportJob();
  const [over, setOver] = useState(false);
  const [owner, setOwner] = useState("");
  const [starting, setStarting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const running = job?.status === "running" || starting;

  const start = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    if (!/\.(mbox|mbx|eml)$/i.test(file.name)) {
      toast.error("Choose an .mbox or .eml file");
      return;
    }
    setStarting(true);
    importState.set({ job: null });
    try {
      await api.importMail(file, owner.trim());
      await refreshSession();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start the import");
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="panel-block" aria-label="Import mail">
      <h3 className="block-title">Import mail</h3>
      <p className="block-lead">Bring in an archive from Google Takeout, Thunderbird or Apple Mail. It stays on this machine.</p>
      <div
        className={`dropzone ${over ? "over" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void start([...e.dataTransfer.files]);
        }}
      >
        <Icon name="upload" size={20} />
        <span>Drop an .mbox or .eml file here</span>
        <button className="btn btn-sm" onClick={() => input.current?.click()} disabled={running}>
          Choose a file
        </button>
        <input ref={input} type="file" accept=".mbox,.mbx,.eml" hidden onChange={(e) => (void start([...(e.target.files ?? [])]), (e.target.value = ""))} />
      </div>
      <label className="form-row import-owner">
        <span>Your address in this archive (optional)</span>
        <input className="field" type="email" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="you@example.com" />
        <small className="form-hint">Helps Slipstream tell which messages you sent.</small>
      </label>
      {running && (
        <div className="import-progress" role="status">
          <span className="spinner" />
          <span className="num">{job?.imported ? `Imported ${job.imported.toLocaleString("en-US")} messages…` : "Reading the archive…"}</span>
        </div>
      )}
      {job?.status === "done" && (
        <div className="import-progress done" role="status">
          <Icon name="check-circle" /> <span className="num">Imported {job.imported.toLocaleString("en-US")} messages.</span>
        </div>
      )}
      {job?.status === "failed" && (
        <div className="form-error" role="alert">
          The import stopped after {job.imported.toLocaleString("en-US")} messages{job.error ? `: ${job.error}` : "."}
        </div>
      )}
    </section>
  );
}

// ---- Send-as addresses --------------------------------------------------------------------------------

function Identities({ account: a }: { account: Account }) {
  const identities = a.identities ?? [];
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Identity | null>(null);
  const [busy, setBusy] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const headId = `ident-${a.id}`;

  const closeAdd = () => {
    setAdding(false);
    requestAnimationFrame(() => addButton.current?.focus());
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api.removeIdentity(a.id, removing.id);
      await refreshSession();
      toast.info(`Removed ${removing.email}`);
      setRemoving(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that address");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ident" aria-labelledby={headId}>
      <div className="ident-head">
        <h4 className="ident-title" id={headId}>
          Send from other addresses
        </h4>
        {!adding && (
          <button ref={addButton} className="btn btn-sm" onClick={() => setAdding(true)} aria-label={`Add an address for ${a.email}`}>
            <Icon name="plus" /> Add address
          </button>
        )}
      </div>
      {a.provider === "gmail" && <p className="form-hint">Aliases you've verified in Gmail appear here on their own.</p>}
      {identities.length === 0 && !adding && <p className="ident-empty muted">No other addresses</p>}
      {identities.length > 0 && (
        <ul className="ident-list" role="list">
          {identities.map((i) => (
            <li key={i.id} className="ident-row">
              {editing === i.id ? (
                <IdentityForm account={a} identity={i} onDone={() => setEditing(null)} />
              ) : (
                <>
                  <span className="ident-main">
                    <span className="ident-email">{i.email}</span>
                    <span className="ident-meta">
                      {[i.name, i.replyTo ? `Replies go to ${i.replyTo}` : "", i.signatureHtml ? "Own signature" : ""].filter(Boolean).join(" · ") || "Uses the account's name"}
                    </span>
                  </span>
                  {i.source === "provider" ? (
                    <span className="chip">{a.provider === "gmail" ? "From Gmail settings" : "From your provider"}</span>
                  ) : (
                    <span className="ident-tools">
                      <button className="btn btn-sm" onClick={() => setEditing(i.id)} aria-label={`Edit ${i.email}`}>
                        Edit
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => setRemoving(i)} aria-label={`Remove ${i.email}`}>
                        Remove
                      </button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && <IdentityForm account={a} onDone={closeAdd} />}
      {removing && (
        <ConfirmDialog title={`Remove ${removing.email}?`} confirmLabel="Remove address" danger busy={busy} onConfirm={() => void remove()} onClose={() => setRemoving(null)}>
          You won't be able to send from this address in Slipstream. Mail already sent from it stays as it is.
        </ConfirmDialog>
      )}
    </section>
  );
}

function IdentityForm({ account, identity, onDone }: { account: Account; identity?: Identity; onDone: () => void }) {
  const [email, setEmail] = useState(identity?.email ?? "");
  const [name, setName] = useState(identity?.name ?? "");
  const [replyTo, setReplyTo] = useState(identity?.replyTo ?? "");
  const [signature, setSignature] = useState(identity?.signatureHtml ?? "");
  const [showSignature, setShowSignature] = useState(Boolean(identity?.signatureHtml));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      email: email.trim(),
      name: name.trim() || undefined,
      replyTo: replyTo.trim() || null,
      signatureHtml: signature.replace(/<[^>]*>/g, "").trim() ? signature : null,
    };
    try {
      if (identity) await api.updateIdentity(account.id, identity.id, body);
      else await api.addIdentity(account.id, body);
      await refreshSession();
      toast.info(identity ? `Saved ${body.email}` : `Added ${body.email}`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that address");
      setBusy(false);
    }
  };

  return (
    <form className="ident-form" onSubmit={submit} aria-label={identity ? `Edit ${identity.email}` : "Add an address"}>
      <div className="form-grid">
        <label className="form-row">
          <span>Email address</span>
          <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required autoFocus />
        </label>
        <label className="form-row">
          <span>Name</span>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={account.name || "Your name"} autoComplete="off" />
        </label>
      </div>
      <label className="form-row">
        <span>Reply-to (optional)</span>
        <input className="field" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} autoComplete="off" />
      </label>
      {showSignature ? (
        <div className="form-row">
          <span id={`sig-${identity?.id ?? "new"}`}>Signature for this address</span>
          <RichBox label="Signature for this address" html={signature} onCommit={setSignature} minHeight={72} />
          <small className="form-hint">Leave it empty to use your general signature.</small>
        </div>
      ) : (
        <button type="button" className="link-btn align-start" onClick={() => setShowSignature(true)}>
          Add a signature for this address
        </button>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions start">
        <button className="btn btn-primary btn-sm" disabled={busy || !email.trim()}>
          {busy ? "Saving…" : identity ? "Save" : "Add address"}
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
