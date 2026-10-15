import { useEffect, useState } from "react";
import { useViewport } from "../lib/hooks.ts";
import { useCompose } from "../store/compose.ts";
import { dismiss, runToastAction, undoLast, useToast } from "../store/toasts.ts";
import { dismissTip, ui, useUi } from "../store/ui.ts";
import { updateSettings, useSession } from "../store/session.ts";
import { Icon } from "./Icon.tsx";
import { Keycap } from "./Keycap.tsx";

export function Toasts() {
  const toast = useToast();
  const [left, setLeft] = useState(0);
  const docked = useCompose((c) => c.open && c.mode === "dock" && !c.inline);
  const viewport = useViewport();

  useEffect(() => {
    if (!toast?.until) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((toast.until! - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [toast?.id, toast?.until]);

  return (
    <div className={`toast-region ${docked && viewport === "desktop" ? "toast-region-left" : ""}`} aria-live="polite" aria-atomic="true">
      {toast && (
        <div className={`toast toast-${toast.kind}`} key={toast.id} role={toast.kind === "error" ? "alert" : "status"}>
          <span className="toast-text">
            {toast.text}
            {toast.until ? <span className="num toast-count"> {left}s</span> : null}
          </span>
          {toast.undoLabel && (
            <button className="toast-action" onClick={() => undoLast()}>
              {toast.undoLabel}
              <Keycap>{toast.undoKey ?? "Z"}</Keycap>
            </button>
          )}
          {toast.actionLabel && (
            <button className="toast-action" onClick={runToastAction}>
              {toast.actionLabel}
            </button>
          )}
          <button className="toast-x" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

/** One quiet line that teaches the shortcut for what the user just did with the mouse. */
export function TipsBar() {
  const tip = useUi((s) => s.tip);
  const enabled = useSession((s) => s.settings.showTips);
  useEffect(() => {
    if (!tip) return;
    const t = setTimeout(() => ui.set({ tip: null }), 9000);
    return () => clearTimeout(t);
  }, [tip]);
  if (!tip || !enabled) return null;
  return (
    <div className="tips" role="note">
      <span>{tip.text}</span>
      <Keycap>{tip.key}</Keycap>
      <button className="link-btn tips-off" onClick={() => void updateSettings({ showTips: false })}>
        Turn off tips
      </button>
      <button className="icon-btn tips-x" aria-label="Dismiss tip" onClick={dismissTip}>
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}
