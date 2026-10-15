import { useMemo, useState } from "react";
import { formatWhen, parseWhen, presets } from "../lib/when.ts";
import { closeRemind, useUi } from "../store/ui.ts";
import { useSession } from "../store/session.ts";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";

/** Remind Me and Send Later share this: type a time in plain words or pick a preset. */
export function RemindPopover() {
  const request = useUi((s) => s.remind);
  if (!request) return null;
  return <Picker title={request.title} onPick={request.onPick} />;
}

function Picker({ title, onPick }: { title: string; onPick: (at: Date) => void }) {
  const hour = useSession((s) => s.settings.defaultRemindHour);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const now = useMemo(() => new Date(), []);
  const parsed = useMemo(() => parseWhen(text, hour, now), [text, hour, now]);
  const options = useMemo(() => {
    const list = presets(hour, now).map((p) => ({ id: p.id, label: p.label, at: p.at }));
    return parsed ? [{ id: "typed", label: text.trim(), at: parsed }, ...list] : list;
  }, [parsed, text, hour, now]);

  const choose = (at: Date) => {
    closeRemind();
    onPick(at);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = options[Math.min(active, options.length - 1)];
      if (o) choose(o.at);
    }
  };

  return (
    <Dialog label={title} onClose={closeRemind} placement="top" className="dialog-remind" initialFocus="input">
      <div className="remind" onKeyDown={onKeyDown}>
        <div className="remind-input">
          <Icon name="clock" />
          <input
            value={text}
            onChange={(e) => (setText(e.target.value), setActive(0))}
            placeholder={title === "Send later" ? "Send when? Try “tomorrow 9am”" : "Remind me… try “tomorrow 9am” or “fri”"}
            aria-label={title}
            autoComplete="off"
            spellCheck={false}
          />
          <span className={`remind-parsed ${parsed ? "ok" : ""} num`} aria-live="polite">
            {parsed ? formatWhen(parsed, now) : text.trim() ? "No time found" : ""}
          </span>
        </div>
        <ul className="remind-list" role="listbox" aria-label="Times">
          {options.map((o, i) => (
            <li key={o.id} role="option" aria-selected={i === active} className={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onClick={() => choose(o.at)}>
              <span className="remind-label">{o.id === "typed" ? `“${o.label}”` : o.label}</span>
              <span className="remind-when num">{formatWhen(o.at, now)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
