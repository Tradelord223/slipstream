import { useState } from "react";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { refreshCounts } from "../../store/counts.ts";
import { refreshSession, updateSettings, useSession } from "../../store/session.ts";
import { toast } from "../../store/toasts.ts";
import type { Helpers } from "../../types.ts";
import { Setting } from "./GeneralSettings.tsx";

const SPLITS = [
  { name: "Deliveries", query: "is:delivery", blurb: "Order and shipping updates" },
  { name: "Sign-in alerts", query: "is:security", blurb: "New sign-ins and password notices" },
] as const;

/** Settings → Helpers: simple rules that spot codes, packages, sign-in alerts and urgent mail. No model involved. */
export function HelpersSettings() {
  const helpers = useSession((s) => s.settings.helpers);
  const set = (patch: Partial<Helpers>) => void updateSettings({ helpers: { ...helpers, ...patch } });

  return (
    <div className="settings-list">
      <div className="settings-group">
        <Setting title="One-time codes" hint="Shows a Copy chip on sign-in and verification codes for 15 minutes, and Shift+C copies the code.">
          <Switch label="One-time codes" checked={helpers.codes} onChange={(codes) => set({ codes })} />
        </Setting>
        <Setting title="Delivery updates" hint="Older updates move to Done. You can undo them from Activity.">
          <div className="radio-list" role="radiogroup" aria-label="Delivery updates">
            <label className="radio">
              <input type="radio" name="deliveries" checked={helpers.deliveries === "latest"} onChange={() => set({ deliveries: "latest" })} />
              <span>Keep only the latest update for each package</span>
            </label>
            <label className="radio">
              <input type="radio" name="deliveries" checked={helpers.deliveries === "all"} onChange={() => set({ deliveries: "all" })} />
              <span>Keep every update</span>
            </label>
          </div>
        </Setting>
        <Setting title="Sign-in alerts" hint="Marks new sign-in and password notices. They stay in your inbox.">
          <Switch label="Sign-in alerts" checked={helpers.securityAlerts} onChange={(securityAlerts) => set({ securityAlerts })} />
        </Setting>
        <Setting title="Urgent mail" hint="Flags legal notices, overdue bills and deadlines from people.">
          <Switch label="Urgent mail" checked={helpers.urgent} onChange={(urgent) => set({ urgent })} />
        </Setting>
      </div>

      <section className="panel-block" aria-labelledby="helpers-splits">
        <h3 className="block-title" id="helpers-splits">
          Add a split
        </h3>
        <ul className="library" role="list">
          {SPLITS.map((l) => (
            <SplitAction key={l.query} {...l} />
          ))}
        </ul>
        <p className="block-lead">
          Search with <code>is:code</code>, <code>is:delivery</code>, <code>is:security</code> and <code>is:urgent</code>.
        </p>
      </section>
    </div>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span aria-hidden="true">{checked ? "On" : "Off"}</span>
    </label>
  );
}

function SplitAction({ name, query, blurb }: { name: string; query: string; blurb: string }) {
  const added = useSession((s) => s.splits.some((x) => x.query.trim().toLowerCase() === query));
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await api.createSplit(name, query);
      await refreshSession();
      refreshCounts(true);
      toast.info(`Added ${name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add that split");
    } finally {
      setBusy(false);
    }
  };
  return (
    <li>
      <button className="library-item" onClick={() => void add()} disabled={added || busy} aria-label={added ? `${name} is already a split` : `Add the ${name} split`}>
        <span className="library-name">{name}</span>
        <span className="library-blurb">{blurb}</span>
        <code className="library-query">{query}</code>
        <span className={`library-add ${added ? "done" : ""}`}>
          {added ? (
            <>
              <Icon name="check" size={14} /> Added
            </>
          ) : busy ? (
            "Adding…"
          ) : (
            "Add"
          )}
        </span>
      </button>
    </li>
  );
}
