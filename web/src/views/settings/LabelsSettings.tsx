import { useEffect } from "react";
import { Icon } from "../../components/Icon.tsx";
import { LabelDot } from "../../components/labels/LabelChip.tsx";
import { openLabelDialog } from "../../components/labels/LabelDialogs.tsx";
import { plural } from "../../lib/format.ts";
import { useStore } from "../../store/createStore.ts";
import { deleteRule, labelStore, loadRules, refreshLabels, updateRule, useLabels, useLabelsSupported } from "../../store/labels.ts";
import type { LabelRule } from "../../types.ts";

export function LabelsSettings() {
  return (
    <div className="settings-list">
      <LabelManager />
      <Rules />
    </div>
  );
}

function LabelManager() {
  const labels = useLabels();
  const supported = useLabelsSupported();
  useEffect(() => refreshLabels(true), []);
  return (
    <section className="panel-block" aria-label="Labels">
      <div className="ag-panel-head">
        <p className="block-lead">Labels group conversations without moving them. Nest them with a slash, like Clients/Fernpoint.</p>
        {supported && (
          <button className="btn btn-primary" onClick={() => openLabelDialog({ kind: "create" })}>
            <Icon name="plus" /> New label
          </button>
        )}
      </div>
      {!supported && <p className="ag-meta">This server can't change labels yet, so they're listed here as they are.</p>}
      {labels.length === 0 ? (
        <div className="ag-empty">
          <div className="empty-title">No labels yet</div>
          <div className="empty-hint">Press L on a conversation to make the first one.</div>
        </div>
      ) : (
        <ul className="lb-list" role="list">
          {[...labels]
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
            .map((l) => (
              <li key={l.name} className="lb-row">
                <button className="lb-swatch" aria-label={`Change the color of ${l.name}`} disabled={!supported} onClick={() => openLabelDialog({ kind: "color", label: l })}>
                  <LabelDot color={l.color} size={14} />
                </button>
                <div className="lb-main">
                  <div className="ag-name ellipsis">{l.name}</div>
                  <div className="ag-meta num">{supported ? plural(l.count, "conversation") : ""}</div>
                </div>
                {supported && (
                  <div className="ag-actions">
                    <button className="btn btn-sm" onClick={() => openLabelDialog({ kind: "rule", label: l.name })} aria-label={`Auto-label ${l.name}`}>
                      Auto-label
                    </button>
                    <button className="btn btn-sm" onClick={() => openLabelDialog({ kind: "rename", label: l })} aria-label={`Rename ${l.name}`}>
                      Rename
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => openLabelDialog({ kind: "delete", label: l })} aria-label={`Delete ${l.name}`}>
                      Delete
                    </button>
                  </div>
                )}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function Rules() {
  const rules = useStore(labelStore, (s) => s.rules);
  const supported = useLabelsSupported();
  useEffect(() => void loadRules(), []);
  if (!supported) return null;
  return (
    <section className="panel-block" aria-label="Auto-label rules">
      <div className="ag-panel-head">
        <div>
          <h3 className="block-title">Auto-label rules</h3>
          <p className="block-lead">Mail that matches a search gets the label as it arrives.</p>
        </div>
        <button className="btn" onClick={() => openLabelDialog({ kind: "rule" })}>
          <Icon name="plus" /> New rule
        </button>
      </div>
      {rules === null ? (
        <div className="rv-skeleton ag-skeleton" aria-busy="true" aria-label="Loading rules">
          <span />
        </div>
      ) : rules.length === 0 ? (
        <p className="ag-meta">No rules yet.</p>
      ) : (
        <ul className="lb-list" role="list">
          {rules.map((r) => (
            <RuleRow key={r.id} rule={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RuleRow({ rule }: { rule: LabelRule }) {
  const color = useLabels().find((l) => l.name.toLowerCase() === rule.label.toLowerCase())?.color;
  return (
    <li className={`lb-row ${rule.enabled ? "" : "off"}`}>
      <span className="lb-swatch static">
        <LabelDot color={color} size={14} />
      </span>
      <div className="lb-main">
        <div className="ag-name ellipsis">{rule.label}</div>
        <div className="ag-meta">{rule.query}</div>
      </div>
      <button role="switch" aria-checked={rule.enabled} aria-label={`${rule.label} rule is ${rule.enabled ? "on" : "off"}`} className="tgl" onClick={() => void updateRule(rule.id, { enabled: !rule.enabled }, true)}>
        <span />
      </button>
      <div className="ag-actions">
        <button className="btn btn-sm" onClick={() => openLabelDialog({ kind: "rule", rule })} aria-label={`Edit the ${rule.label} rule`}>
          Edit
        </button>
        <button className="btn btn-sm btn-danger" onClick={() => void deleteRule(rule.id).catch(() => undefined)} aria-label={`Delete the ${rule.label} rule`}>
          Delete
        </button>
      </div>
    </li>
  );
}
