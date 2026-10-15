import { useState } from "react";
import { RichBox } from "../../components/RichBox.tsx";
import { updateSettings, useSession } from "../../store/session.ts";
import type { Settings } from "../../types.ts";

export function Setting({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} className="seg-btn" onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;

export function GeneralSettings() {
  const s = useSession((x) => x.settings);
  const [intro, setIntro] = useState(s.instantIntro);
  const set = (patch: Partial<Settings>) => void updateSettings(patch);

  return (
    <div className="settings-list">
      <Setting title="Theme" hint="Slipstream starts in dark. Match your system, or pick one.">
        <Segmented
          label="Theme"
          value={s.theme}
          onChange={(theme) => set({ theme })}
          options={[
            { id: "system", label: "System" },
            { id: "dark", label: "Dark" },
            { id: "light", label: "Light" },
          ]}
        />
      </Setting>
      <Setting title="Density" hint="Rows are 40px tall, or 34px when compact.">
        <Segmented
          label="Density"
          value={s.density}
          onChange={(density) => set({ density })}
          options={[
            { id: "comfortable", label: "Comfortable" },
            { id: "compact", label: "Compact" },
          ]}
        />
      </Setting>
      <Setting title="Remote images" hint="Images can tell a sender you opened their message. They stay hidden until you say so.">
        <Segmented
          label="Remote images"
          value={s.remoteImages}
          onChange={(remoteImages) => set({ remoteImages })}
          options={[
            { id: "ask", label: "Ask first" },
            { id: "always", label: "Always show" },
          ]}
        />
      </Setting>
      <Setting title="After you finish a conversation" hint="Where focus goes when a conversation leaves the list.">
        <select className="select" aria-label="After you finish a conversation" value={s.autoAdvance} onChange={(e) => set({ autoAdvance: e.target.value as Settings["autoAdvance"] })}>
          <option value="next">Open the next one</option>
          <option value="previous">Open the previous one</option>
          <option value="list">Go back to the list</option>
        </select>
      </Setting>
      <Setting title="Default reminder time" hint="Used when you say “tomorrow” or “fri” without a time.">
        <select className="select" aria-label="Default reminder time" value={s.defaultRemindHour} onChange={(e) => set({ defaultRemindHour: Number(e.target.value) })}>
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {hourLabel(h)}
            </option>
          ))}
        </select>
      </Setting>
      <Setting title="Shortcut tips" hint="A quiet line at the bottom that teaches the key for what you just clicked.">
        <label className="switch">
          <input type="checkbox" checked={s.showTips} onChange={(e) => set({ showTips: e.target.checked })} />
          <span>{s.showTips ? "On" : "Off"}</span>
        </label>
      </Setting>
      <Setting title="Signature" hint="Added to the bottom of new messages and replies.">
        <RichBox label="Signature" html={s.signature} onCommit={(signature) => signature !== s.signature && set({ signature })} />
      </Setting>
      <Setting title="Instant Intro reply" hint="Inserted when you press Shift+⌘I on an introduction. {first_name} is the person who introduced you.">
        <textarea
          className="field"
          rows={2}
          aria-label="Instant Intro reply"
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
          onBlur={() => intro.trim() && intro !== s.instantIntro && set({ instantIntro: intro })}
        />
      </Setting>
    </div>
  );
}
