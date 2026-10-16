import { useRef, useState } from "react";
import { api } from "../../api.ts";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { ConnectFlow } from "../../components/connect/ConnectFlow.tsx";
import { providerLabel } from "../../components/connect/hosts.ts";
import { ImportMail } from "../../components/connect/ImportMail.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Icon } from "../../components/Icon.tsx";
import { RichBox } from "../../components/RichBox.tsx";
import { ago } from "../../lib/format.ts";
import { useNow } from "../../lib/hooks.ts";
import { refreshCounts } from "../../store/counts.ts";
import { reload } from "../../store/list.ts";
import { refreshSession, useSession } from "../../store/session.ts";
import { toast } from "../../store/toasts.ts";
import type { Account, Identity } from "../../types.ts";

export function AccountsSettings() {
  const accounts = useSession((s) => s.accounts);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);

  const closeAdd = () => {
    setAdding(false);
    requestAnimationFrame(() => addButton.current?.focus());
  };

  return (
    <div className="settings-list">
      <section className="panel-block" aria-label="Connected accounts">
        <ul className="account-list" role="list">
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} />
          ))}
          {accounts.length === 0 && <li className="muted account-empty">No accounts yet.</li>}
        </ul>
        <div className="account-add">
          <button ref={addButton} className="btn" onClick={() => setAdding(true)}>
            <Icon name="plus" /> Add account
          </button>
          <button className="link-btn" onClick={() => setImporting((v) => !v)} aria-expanded={importing}>
            Import a mail file
          </button>
        </div>
      </section>
      {importing && <ImportBox />}
      {adding && (
        <Dialog label="Add an account" onClose={closeAdd} className="dialog-connect" lockScrim>
          <ConnectFlow
            variant="dialog"
            title="Add an account"
            onClose={closeAdd}
            onConnected={async (c) => {
              await refreshSession();
              reload(true);
              refreshCounts(true);
              toast.info(`Connected ${c.email}`);
              closeAdd();
            }}
          />
        </Dialog>
      )}
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
            {providerLabel(a)}
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

function ImportBox() {
  const mode = useSession((s) => s.mode);
  return (
    <section className="panel-block" aria-label="Import mail">
      <h3 className="block-title">Import a mail file</h3>
      <p className="block-lead">Bring in an archive from Google Takeout, Thunderbird or Apple Mail. It stays {mode === "team" ? "on your team's server" : "on this machine"}.</p>
      <ImportMail />
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
