import { useId, useRef, useState } from "react";
import { plural } from "../../lib/format.ts";
import { SEARCH_HINTS } from "../../lib/searchHints.ts";
import { matchText, useMatchCount } from "../../lib/useMatchCount.ts";
import { createRule, createLabel, deleteLabel, LABEL_COLORS, recolorLabel, renameLabel, updateRule, useLabels } from "../../store/labels.ts";
import { createStore, useStore } from "../../store/createStore.ts";
import type { LabelInfo, LabelRule } from "../../types.ts";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { Dialog } from "../Dialog.tsx";
import { Icon } from "../Icon.tsx";

export type LabelDialogState =
  | { kind: "create"; name?: string; color?: string | null }
  | { kind: "rename"; label: LabelInfo }
  | { kind: "color"; label: LabelInfo }
  | { kind: "delete"; label: LabelInfo }
  | { kind: "rule"; rule?: LabelRule; label?: string }
  | null;

const dialogs = createStore<{ open: LabelDialogState }>({ open: null });
export const openLabelDialog = (open: LabelDialogState) => dialogs.set({ open });
const close = () => dialogs.set({ open: null });

/** Renders whichever label dialog is open; one host serves the rail, Settings and the label header. */
export function LabelDialogHost() {
  const open = useStore(dialogs, (s) => s.open);
  if (!open) return null;
  switch (open.kind) {
    case "create":
      return <NameDialog initial={open.name ?? ""} initialColor={open.color ?? null} />;
    case "rename":
      return <NameDialog label={open.label} initial={open.label.name} initialColor={open.label.color} />;
    case "color":
      return <ColorDialog label={open.label} />;
    case "delete":
      return <DeleteDialog label={open.label} />;
    case "rule":
      return <RuleDialog rule={open.rule} label={open.label} />;
  }
}

/** Twelve swatches and "no colour", as one radio group. */
export function ColorSwatches({ value, onChange, label = "Color" }: { value: string | null; onChange: (hex: string | null) => void; label?: string }) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {LABEL_COLORS.map((c) => (
        <button key={c.hex} type="button" role="radio" aria-checked={value?.toLowerCase() === c.hex} aria-label={c.name} title={c.name} className="swatch" style={{ ["--sw" as string]: c.hex }} onClick={() => onChange(c.hex)}>
        </button>
      ))}
      <button type="button" role="radio" aria-checked={value === null} aria-label="No color" title="No color" className="swatch none" onClick={() => onChange(null)}>
      </button>
    </div>
  );
}

function Frame({ title, onSubmit, busy, submit, error, children }: { title: string; onSubmit: () => void; busy: boolean; submit: string; error: string | null; children: React.ReactNode }) {
  return (
    <Dialog label={title} onClose={close} className="dialog-agent dialog-label" initialFocus="[data-first]">
      <form
        className="ag-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="dialog-head ag-head">
          <h3 aria-hidden="true">{title}</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ag-body">
          {children}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="ag-foot form-actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {submit}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function NameDialog({ label, initial, initialColor }: { label?: LabelInfo; initial: string; initialColor: string | null }) {
  const labels = useLabels();
  const [name, setName] = useState(initial);
  const [color, setColor] = useState<string | null>(initialColor);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const clean = name.trim().replace(/\s*\/\s*/g, "/").replace(/^\/+|\/+$/g, "");
    if (!clean) return setError("Give the label a name.");
    if (clean.length > 100) return setError("Keep the name under 100 characters.");
    if (labels.some((l) => l.name.toLowerCase() === clean.toLowerCase() && l.name !== label?.name)) return setError("You already have a label with that name.");
    if (label && clean === label.name) return close();
    setError(null);
    setBusy(true);
    try {
      if (label) await renameLabel(label.name, clean);
      else await createLabel(clean, color);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the label");
      setBusy(false);
    }
  };

  return (
    <Frame title={label ? "Rename label" : "New label"} onSubmit={() => void submit()} busy={busy} submit={label ? "Rename" : "Create label"} error={error}>
      <label className="form-row">
        <span>Name</span>
        <input data-first className="field" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <span className="form-hint">Use a slash to nest it, like Clients/Fernpoint.</span>
      </label>
      {!label && (
        <div className="form-row">
          <span>Color</span>
          <ColorSwatches value={color} onChange={setColor} />
        </div>
      )}
    </Frame>
  );
}

function ColorDialog({ label }: { label: LabelInfo }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pick = async (hex: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await recolorLabel(label.name, hex);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change the color");
      setBusy(false);
    }
  };
  return (
    <Dialog label={`Color for ${label.name}`} onClose={close} className="dialog-agent dialog-label" initialFocus='[aria-checked="true"], .swatch'>
      <div className="ag-form">
        <div className="dialog-head ag-head">
          <h3 aria-hidden="true">Color for {label.name}</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ag-body" aria-busy={busy}>
          <ColorSwatches value={label.color} onChange={(hex) => void pick(hex)} />
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function DeleteDialog({ label }: { label: LabelInfo }) {
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      title={`Delete ${label.name}?`}
      confirmLabel="Delete label"
      danger
      busy={busy}
      onClose={close}
      onConfirm={() => {
        setBusy(true);
        deleteLabel(label.name).then(close, () => (setBusy(false), close()));
      }}
    >
      {label.count > 0 ? `It comes off ${plural(label.count, "conversation")}. The conversations stay where they are.` : "No conversation has it right now."}
    </ConfirmDialog>
  );
}

/** Label mail automatically: the search that picks it, and whether to catch up on what's already here. */
function RuleDialog({ rule, label: preset }: { rule?: LabelRule; label?: string }) {
  const id = useId();
  const labels = useLabels();
  const [label, setLabel] = useState(rule?.label ?? preset ?? "");
  const [query, setQuery] = useState(rule?.query ?? "");
  const [existing, setExisting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const queryField = useRef<HTMLInputElement>(null);
  const match = useMatchCount(query);

  const addToken = (token: string) => {
    setQuery((q) => `${q && !q.endsWith(" ") ? `${q} ` : q}${token}`);
    queryField.current?.focus();
  };

  const submit = async () => {
    if (!label.trim()) return setError("Choose the label to apply.");
    if (!query.trim()) return setError("Enter a search for the mail it should label.");
    setError(null);
    setBusy(true);
    try {
      if (rule) await updateRule(rule.id, { label: label.trim(), query: query.trim() });
      else await createRule(label.trim(), query.trim(), existing);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the rule");
      setBusy(false);
    }
  };

  return (
    <Frame title={rule ? "Edit auto-label rule" : "New auto-label rule"} onSubmit={() => void submit()} busy={busy} submit={rule ? "Save rule" : "Add rule"} error={error}>
      <label className="form-row">
        <span>Apply the label</span>
        <input data-first className="field" list={`${id}-labels`} value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} autoComplete="off" placeholder="Clients" />
        <datalist id={`${id}-labels`}>
          {labels.map((l) => (
            <option key={l.name} value={l.name} />
          ))}
        </datalist>
      </label>
      <label className="form-row">
        <span>To mail that matches</span>
        <input ref={queryField} className="field" value={query} maxLength={500} onChange={(e) => setQuery(e.target.value)} placeholder="from:@kettlebyfreight.com" autoComplete="off" spellCheck={false} aria-describedby={`${id}-match`} />
      </label>
      <div className="rt-hints" role="group" aria-label="Search operators">
        {SEARCH_HINTS.map((h) => (
          <button key={h.token} type="button" className="rt-hint" onClick={() => addToken(h.token)} title={h.note}>
            {h.token}
          </button>
        ))}
      </div>
      <p className="form-hint" id={`${id}-match`} role="status">
        {matchText(match) || "New mail that matches gets the label as it arrives."}
      </p>
      {!rule && (
        <label className="ag-check">
          <input type="checkbox" checked={existing} onChange={(e) => setExisting(e.target.checked)} />
          <span>
            <span className="ag-check-title">Also apply to existing mail</span>
            <span className="ag-check-hint">Label what already matches, not only what arrives next.</span>
          </span>
        </label>
      )}
    </Frame>
  );
}

