import { Fragment, useEffect, useRef, useState } from "react";
import { engineLine, shortModel } from "../../lib/engines.ts";
import { useDismiss } from "../../lib/hooks.ts";
import { chooseEngine, useEffectiveEngine, useEngines } from "../../store/engines.ts";
import { navigate } from "../../store/route.ts";
import { toast } from "../../store/toasts.ts";
import type { EngineStatus } from "../../types.ts";
import { Icon } from "../Icon.tsx";

/** The model a new chat will run on, and a small menu to change it. Choosing one is remembered as the default. */
export function EnginePicker({ onSetup }: { onSetup?: () => void }) {
  const overview = useEngines((s) => s.overview);
  const current = useEffectiveEngine();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(wrap, open, () => setOpen(false));

  // Focus the chosen engine (or the first one) when the menu opens.
  useEffect(() => {
    if (!open) return;
    const items = wrap.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]');
    (wrap.current?.querySelector<HTMLElement>('[aria-checked="true"]') ?? items?.[0])?.focus();
  }, [open]);

  if (!overview) return null;

  const choose = async (e: EngineStatus) => {
    setOpen(false);
    button.current?.focus();
    if (e.id === current?.id && overview.defaultEngine === e.id) return;
    try {
      await chooseEngine(e.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't change the model");
    }
  };

  const onMenuKey = (ev: React.KeyboardEvent) => {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], .as-engine-setup') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(i + (ev.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    ev.preventDefault();
    next?.focus();
  };

  return (
    <div className="as-engine" ref={wrap}>
      <button
        ref={button}
        className="as-engine-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={current ? `Model: ${engineLine(current)}. Change` : "Choose a model"}
        title={current ? engineLine(current) : "Choose a model"}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`eng-dot ${current?.ready ? "ready" : ""}`} aria-hidden="true" />
        <span className="as-engine-name ellipsis">{current ? current.label : "Choose a model"}</span>
        {current?.model && <span className="as-engine-model ellipsis">{shortModel(current.model)}</span>}
        <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="menu menu-up as-engine-menu" role="menu" aria-label="Model for new chats" onKeyDown={onMenuKey}>
          {[...overview.engines.filter((e) => e.ready), ...overview.engines.filter((e) => !e.ready)].map((e, i, all) => (
            <Fragment key={e.id}>
              {!e.ready && all[i - 1]?.ready && <div className="menu-sep" role="separator" />}
              {e.ready ? (
                <button role="menuitemradio" aria-checked={e.id === current?.id} className="menu-item as-engine-item" onClick={() => void choose(e)}>
                  <span className="eng-dot ready" aria-hidden="true" />
                  <span className="as-engine-text">
                    <span className="as-engine-label">{e.label}</span>
                    {e.model && <span className="as-engine-sub">{shortModel(e.model)}</span>}
                  </span>
                  <span className="chip eng-tag">{e.billing === "plan" ? "Plan" : "API"}</span>
                  {e.id === current?.id && <Icon name="check" size={14} />}
                </button>
              ) : (
                <div className="as-engine-item off" role="group" aria-label={`${e.label}, not set up`}>
                  <span className="eng-dot" aria-hidden="true" />
                  <span className="as-engine-text">
                    <span className="as-engine-label">{e.label}</span>
                    <span className="as-engine-sub">{e.detail}</span>
                  </span>
                  <button
                    className="as-engine-setup" role="menuitem"
                    aria-label={`Set up ${e.label}`}
                    onClick={() => {
                      setOpen(false);
                      onSetup?.();
                      navigate("/settings/models");
                    }}
                  >
                    Set up
                  </button>
                </div>
              )}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
