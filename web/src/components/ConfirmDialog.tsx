import type { ReactNode } from "react";
import { Dialog } from "./Dialog.tsx";

/** A yes/no question. Focus starts on Cancel so Enter never destroys something by accident. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog label={title} onClose={onClose} className="dialog-narrow" initialFocus="[data-cancel]">
      <div className="dialog-head">
        <h3 aria-hidden="true">{title}</h3>
      </div>
      <div className="dialog-copy">{children}</div>
      <div className="form-actions">
        <button className="btn" data-cancel onClick={onClose}>
          Cancel
        </button>
        <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
