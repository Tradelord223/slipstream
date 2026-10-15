import { useState } from "react";
import { AgentGlyph } from "../../components/AgentGlyph.tsx";
import { ConfirmDialog } from "../../components/ConfirmDialog.tsx";
import { scopeLabel } from "../../lib/scopes.ts";
import { assistant } from "../../store/assistant.ts";
import { disconnectCloud, dollars, modelName, useCloud } from "../../store/cloud.ts";
import { navigate } from "../../store/route.ts";
import { toast } from "../../store/toasts.ts";

/** The managed cloud agent, first in Settings → Agents when it's linked. */
export function CloudCard() {
  const status = useCloud((s) => s.status);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!status?.connected || !status.agent) return null;
  const agent = status.agent;

  const disconnect = async () => {
    setBusy(true);
    try {
      await disconnectCloud();
      toast.info("Claude is disconnected");
      setConfirming(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't disconnect Claude");
      setBusy(false);
    }
  };

  return (
    <section className="panel-block cl-card" aria-label={agent.name}>
      <div className="ag-row cl-card-row">
        <AgentGlyph name={agent.name} size={36} />
        <div className="ag-main">
          <div className="ag-name">{agent.name}</div>
          <div className="ag-tags" aria-label="Access">
            {agent.scopes.map((s) => (
              <span className="chip" key={s}>
                {scopeLabel(s)}
              </span>
            ))}
          </div>
          <div className="ag-meta num">
            Up to {dollars(status.runBudgetCents)} a run · {dollars(status.monthlyBudgetCents)} a month · {dollars(status.spentThisMonthCents)} spent so far
          </div>
          <div className="ag-meta">{agent.scopes.includes("send") ? "Asks you before every send" : "Can't send mail"} · {modelName(status.model)}</div>
        </div>
        <div className="ag-actions">
          <button className="btn btn-sm" onClick={() => navigate("/agent")}>
            Manage
          </button>
          <button className="btn btn-sm" onClick={() => assistant.set({ accessOpen: true })} aria-label="Change what Claude can do and spend">
            Edit
          </button>
          <button className="btn btn-sm btn-danger" onClick={() => setConfirming(true)}>
            Disconnect
          </button>
        </div>
      </div>
      {confirming && (
        <ConfirmDialog title="Disconnect Claude?" confirmLabel="Disconnect" danger busy={busy} onConfirm={() => void disconnect()} onClose={() => setConfirming(false)}>
          Claude stops working in your mail and its access is revoked. Your routines and past chats stay, and you can connect again later.
        </ConfirmDialog>
      )}
    </section>
  );
}
