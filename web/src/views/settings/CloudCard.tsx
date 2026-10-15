import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { scopeLabel } from "../../lib/scopes.ts";
import { assistant } from "../../store/assistant.ts";
import { disconnectCloud, modelName } from "../../store/cloud.ts";
import { refreshEngines } from "../../store/engines.ts";
import { navigate } from "../../store/route.ts";
import { toast } from "../../store/toasts.ts";
import type { CloudStatus } from "../../types.ts";

/** What the connected managed agent can do, for its engine card in Models & accounts. */
export function ManagedDetails({ status }: { status: CloudStatus }) {
  const agent = status.agent;
  if (!agent) return null;
  return (
    <>
      <div className="ag-tags" aria-label="Access">
        {agent.scopes.map((s) => (
          <span className="chip" key={s}>
            {scopeLabel(s)}
          </span>
        ))}
      </div>
      <p className="eng-note">{agent.scopes.includes("send") ? "Asks you before every send." : "Can't send mail."}</p>
    </>
  );
}

/** Manage, edit and disconnect the connected managed agent. */
export function ManagedActions() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const disconnect = async () => {
    setBusy(true);
    try {
      await disconnectCloud();
      void refreshEngines();
      toast.info("Claude is disconnected");
      setConfirming(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't disconnect Claude");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="btn btn-sm" onClick={() => navigate("/agent")}>
        Manage
      </button>
      <button className="btn btn-sm" onClick={() => assistant.set({ accessOpen: true })} aria-label="Change what Claude can do and spend">
        Edit
      </button>
      <button className="btn btn-sm btn-danger" onClick={() => setConfirming(true)}>
        Disconnect
      </button>
      {confirming && (
        <ConfirmDialog title="Disconnect Claude?" confirmLabel="Disconnect" danger busy={busy} onConfirm={() => void disconnect()} onClose={() => setConfirming(false)}>
          Claude stops working in your mail and its access is revoked. Your routines and past chats stay, and you can connect again later.
        </ConfirmDialog>
      )}
    </>
  );
}
