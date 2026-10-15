import { useId, useMemo, useRef, useState } from "react";
import { Dialog } from "../../components/Dialog.tsx";
import { Icon } from "../../components/Icon.tsx";
import { DAY_LETTERS, DAY_NAMES, EVERY_DAY, WEEKDAYS, browserZone, timeZones } from "../../lib/routines.ts";
import { SEARCH_HINTS } from "../../lib/searchHints.ts";
import { matchText, useMatchCount } from "../../lib/useMatchCount.ts";
import { saveRoutine } from "../../store/cloud.ts";
import { toast } from "../../store/toasts.ts";
import type { Routine, RoutineInput } from "../../types.ts";

/** Make or change a routine: what Claude should do, and what sets it off. */
export function RoutineEditor({ routine, seed, onClose }: { routine?: Routine; seed?: RoutineInput; onClose: () => void }) {
  const start = routine ?? seed;
  const id = useId();
  const [name, setName] = useState(start?.name ?? "");
  const [instruction, setInstruction] = useState(start?.instruction ?? "");
  const [type, setType] = useState<"schedule" | "mail">(start?.trigger.type ?? "schedule");
  const sched = start?.trigger.type === "schedule" ? start.trigger : null;
  const [days, setDays] = useState<Set<number>>(new Set(sched?.days ?? WEEKDAYS));
  const [time, setTime] = useState(sched?.time ?? "08:00");
  const [zone, setZone] = useState(sched?.timezone ?? browserZone());
  const [query, setQuery] = useState(start?.trigger.type === "mail" ? start.trigger.query : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const queryField = useRef<HTMLInputElement>(null);
  const zones = useMemo(() => {
    const all = (() => {
      const base = timeZones();
      return base.includes(zone) ? base : [zone, ...base];
    })();
    return all;
  }, [zone]);
  const match = useMatchCount(type === "mail" ? query : "");

  const toggleDay = (d: number) =>
    setDays((cur) => {
      const next = new Set(cur);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  const preset = (list: number[]) => setDays(new Set(list));
  const same = (a: Set<number>, b: number[]) => a.size === b.length && b.every((d) => a.has(d));

  const addToken = (token: string) => {
    setQuery((q) => `${q && !q.endsWith(" ") ? `${q} ` : q}${token}`);
    queryField.current?.focus();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Give the routine a name.");
    if (!instruction.trim()) return setError("Say what Claude should do.");
    if (type === "schedule" && days.size === 0) return setError("Pick at least one day.");
    if (type === "schedule" && !/^\d{2}:\d{2}$/.test(time)) return setError("Choose a time.");
    if (type === "mail" && !query.trim()) return setError("Enter a search for the mail that should set it off.");
    setError(null);
    setBusy(true);
    const input: RoutineInput = {
      name: name.trim(),
      instruction: instruction.trim(),
      enabled: routine?.enabled ?? true,
      trigger: type === "schedule" ? { type: "schedule", days: [...days].sort((a, b) => a - b), time, timezone: zone } : { type: "mail", query: query.trim() },
    };
    try {
      await saveRoutine(input, routine?.id);
      toast.info(routine ? "Routine saved" : "Routine added");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the routine");
      setBusy(false);
    }
  };

  return (
    <Dialog label={routine ? `Edit ${routine.name}` : "New routine"} onClose={onClose} className="dialog-agent" initialFocus="#rt-name">
      <form className="ag-form" onSubmit={submit} noValidate>
        <div className="dialog-head ag-head">
          <h3 aria-hidden="true">{routine ? "Edit routine" : "New routine"}</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="ag-body">
          <label className="form-row">
            <span>Name</span>
            <input id="rt-name" className="field" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </label>
          <label className="form-row">
            <span>What Claude should do</span>
            <textarea className="field" rows={4} value={instruction} maxLength={4000} onChange={(e) => setInstruction(e.target.value)} />
          </label>
          <div className="form-row">
            <span id={`${id}-when`}>Runs</span>
            <div className="seg" role="radiogroup" aria-labelledby={`${id}-when`}>
              <button type="button" role="radio" aria-checked={type === "schedule"} className="seg-btn" onClick={() => setType("schedule")}>
                On a schedule
              </button>
              <button type="button" role="radio" aria-checked={type === "mail"} className="seg-btn" onClick={() => setType("mail")}>
                When mail arrives
              </button>
            </div>
          </div>
          {type === "schedule" ? (
            <div className="rt-when">
              <div className="form-row">
                <span id={`${id}-days`}>Days</span>
                <div className="rt-days-row">
                  <div className="rt-days" role="group" aria-labelledby={`${id}-days`}>
                    {DAY_LETTERS.map((letter, d) => (
                      <button key={d} type="button" className="rt-day" aria-pressed={days.has(d)} aria-label={DAY_NAMES[d]} title={DAY_NAMES[d]} onClick={() => toggleDay(d)}>
                        {letter}
                      </button>
                    ))}
                  </div>
                  <button type="button" className="btn btn-sm btn-quiet" aria-pressed={same(days, WEEKDAYS)} onClick={() => preset(WEEKDAYS)}>
                    Weekdays
                  </button>
                  <button type="button" className="btn btn-sm btn-quiet" aria-pressed={same(days, EVERY_DAY)} onClick={() => preset(EVERY_DAY)}>
                    Every day
                  </button>
                </div>
              </div>
              <div className="rt-time-row">
                <label className="form-row">
                  <span>Time</span>
                  <input className="field num" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
                </label>
                <label className="form-row rt-zone">
                  <span>Time zone</span>
                  <select className="select" value={zone} onChange={(e) => setZone(e.target.value)}>
                    {zones.map((z) => (
                      <option key={z} value={z}>
                        {z.replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          ) : (
            <div className="rt-when">
              <label className="form-row">
                <span>Mail that matches</span>
                <input ref={queryField} className="field" value={query} maxLength={500} onChange={(e) => setQuery(e.target.value)} placeholder="from:@fernpoint.co" autoComplete="off" spellCheck={false} aria-describedby={`${id}-match`} />
              </label>
              <div className="rt-hints" role="group" aria-label="Search operators">
                {SEARCH_HINTS.map((h) => (
                  <button key={h.token} type="button" className="rt-hint" onClick={() => addToken(h.token)} title={h.note}>
                    {h.token}
                  </button>
                ))}
              </div>
              <p className="form-hint" id={`${id}-match`} role="status">
                {matchText(match) || "It runs when new mail in your inbox matches."}
              </p>
            </div>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="ag-foot form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy}>
            {routine ? "Save changes" : "Add routine"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
