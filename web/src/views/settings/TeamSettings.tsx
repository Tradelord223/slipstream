import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { ago } from "../../lib/format.ts";
import { useSession } from "../../store/session.ts";
import { toast } from "../../store/toasts.ts";
import type { TeamInfo } from "../../types.ts";

export function TeamSettings() {
  const mode = useSession((s) => s.mode);
  const workspace = useSession((s) => s.workspace);
  if (mode !== "team" || !workspace) {
    return (
      <div className="settings-list">
        <section className="panel-block">
          <h3 className="block-title">Teams run on a self-hosted server</h3>
          <p className="block-lead">
            This copy of Slipstream is yours alone and everything stays on this machine. To share conversations, comment on them and share snippets, run Slipstream on a server for your team.
            The steps are in <a href="https://github.com/Tradelord223/slipstream/blob/main/docs/self-hosting.md" target="_blank" rel="noopener noreferrer">the self-hosting guide</a>.
          </p>
        </section>
      </div>
    );
  }
  return <TeamAdmin />;
}

function TeamAdmin() {
  const workspace = useSession((s) => s.workspace)!;
  const me = useSession((s) => s.user);
  const [team, setTeam] = useState<TeamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const isOwner = workspace.role === "owner";

  const load = useCallback(() => {
    api
      .team()
      .then((t) => (setTeam(t), setError(null)))
      .catch((err: Error) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  const createInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.createInvite(email.trim() || undefined);
      setInvite(res.url);
      setEmail("");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create an invite");
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite);
      toast.info("Invite link copied");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it.");
    }
  };
  const remove = async (id: string, name: string) => {
    try {
      await api.removeMember(id);
      toast.info(`Removed ${name}`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that person");
    }
  };

  return (
    <div className="settings-list">
      <section className="panel-block" aria-label="Members">
        <h3 className="block-title">{workspace.name}</h3>
        {error && <div className="form-error" role="alert">{error}</div>}
        <ul className="member-list" role="list">
          {team?.members.map((m) => (
            <li key={m.id} className="member-row">
              <span className="account-main">
                <span className="account-email">{m.name}</span>
                <span className="account-meta">{m.email}</span>
              </span>
              <span className="chip">{m.role === "owner" ? "Owner" : "Member"}</span>
              {isOwner && m.id !== me?.id && (
                <button className="btn btn-sm btn-danger" onClick={() => void remove(m.id, m.name)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section className="panel-block" aria-label="Invite people">
        <h3 className="block-title">Invite someone</h3>
        <form className="invite-form" onSubmit={createInvite}>
          <input className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Their email (optional)" aria-label="Their email" />
          <button className="btn btn-primary" disabled={busy}>
            Create invite link
          </button>
        </form>
        {invite && (
          <div className="invite-link">
            <input className="field num" readOnly value={invite} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
            <button className="btn" onClick={() => void copy()}>
              <Icon name="copy" /> Copy
            </button>
          </div>
        )}
        {team && team.invites.length > 0 && (
          <ul className="member-list" role="list" aria-label="Pending invites">
            {team.invites.map((i, n) => (
              <li key={n} className="member-row">
                <span className="account-main">
                  <span className="account-email">{i.email ?? "Anyone with the link"}</span>
                  <span className="account-meta">Expires {ago(i.expiresAt).replace(" ago", "") === "never" ? "soon" : new Date(i.expiresAt).toLocaleDateString()}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
