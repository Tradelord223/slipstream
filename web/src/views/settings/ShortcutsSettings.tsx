import { useEffect, useMemo, useRef, useState } from "react";
import { Keys } from "../../components/Keycap.tsx";
import { Icon } from "../../components/Icon.tsx";
import { COMMANDS, type CommandDef } from "../../keys/commands.ts";
import { eventKey } from "../../keys/keys.ts";
import { bindingsOf, conflictsFor } from "../../keys/registry.ts";
import { updateSettings, useSession } from "../../store/session.ts";
import { ui } from "../../store/ui.ts";

const GROUP_ORDER = ["Move", "Triage", "Select", "Review", "Write", "Compose", "Go to", "General"];

export function ShortcutsSettings() {
  const keymap = useSession((s) => s.settings.keymap);
  const ai = useSession((s) => s.features.ai);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);

  const groups = useMemo(() => {
    const by = new Map<string, CommandDef[]>();
    for (const c of COMMANDS) {
      if (c.id.startsWith("account.") || c.id === "compose.replyAllList" || (c.id === "compose.ai" && !ai)) continue;
      by.set(c.group, [...(by.get(c.group) ?? []), c]);
    }
    return [...by.entries()].sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]));
  }, [ai]);

  const save = (id: string, binding: string) => {
    const hits = conflictsFor(binding, id);
    setMessage(hits.length ? { id, text: `Also used by ${hits.map((h) => h.title).join(", ")}` } : null);
    void updateSettings({ keymap: { ...keymap, [id]: binding } });
    setCapturing(null);
  };
  const reset = (id: string) => {
    const { [id]: _removed, ...rest } = keymap;
    void _removed;
    void updateSettings({ keymap: rest });
    setMessage(null);
  };
  const overridden = Object.keys(keymap).length;

  return (
    <div className="settings-list">
      <p className="block-lead">
        Click a shortcut, then press the keys you want. For two keys in a row, like <kbd className="keycap">G</kbd> <kbd className="keycap">I</kbd>, press them one after the other.
      </p>
      {overridden > 0 && (
        <div>
          <button className="btn btn-sm" onClick={() => void updateSettings({ keymap: {} })}>
            Reset all shortcuts
          </button>
        </div>
      )}
      {groups.map(([group, cmds]) => (
        <section key={group} className="panel-block" aria-label={group}>
          <h3 className="block-title">{group}</h3>
          <ul className="keymap" role="list">
            {cmds.map((c) => {
              const bindings = bindingsOf(c, keymap);
              const custom = keymap[c.id] !== undefined;
              return (
                <li key={c.id} className="keymap-row">
                  <span className="keymap-title">{c.title}</span>
                  {message?.id === c.id && <span className="keymap-warn">{message.text}</span>}
                  <span className="keymap-keys">
                    {capturing === c.id ? (
                      <Capture onDone={(b) => save(c.id, b)} onCancel={() => setCapturing(null)} />
                    ) : (
                      <button className={`keymap-btn ${custom ? "custom" : ""}`} onClick={() => (setMessage(null), setCapturing(c.id))} aria-label={`Change shortcut for ${c.title}`}>
                        {bindings.length ? bindings.map((b) => <Keys key={b} binding={b} />) : <span className="muted">Not set</span>}
                      </button>
                    )}
                    {custom && capturing !== c.id && (
                      <button className="icon-btn" aria-label={`Reset ${c.title}`} title="Reset to default" onClick={() => reset(c.id)}>
                        <Icon name="undo" />
                      </button>
                    )}
                    {!custom && capturing !== c.id && bindings.length > 0 && (
                      <button className="icon-btn ghost" aria-label={`Clear shortcut for ${c.title}`} title="Clear" onClick={() => save(c.id, "")}>
                        <Icon name="x" />
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Listens for one key or a two-key sequence. Esc cancels. */
function Capture({ onDone, onCancel }: { onDone: (binding: string) => void; onCancel: () => void }) {
  const [keys, setKeys] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keysRef = useRef<string[]>([]);

  useEffect(() => {
    ui.set({ capturing: true });
    const onKey = (e: KeyboardEvent) => {
      const k = eventKey(e);
      if (!k) return;
      e.preventDefault();
      e.stopPropagation();
      if (k === "escape") return onCancel();
      const next = [...keysRef.current, k].slice(0, 2);
      keysRef.current = next;
      setKeys(next);
      clearTimeout(timer.current);
      // Modifier combos finish at once; plain keys wait briefly for a second key.
      const hasMod = /(mod|ctrl|alt)\+/.test(k);
      if (next.length === 2 || hasMod) onDone(next.join(" "));
      else timer.current = setTimeout(() => onDone(next.join(" ")), 700);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(timer.current);
      ui.set({ capturing: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <span className="capture" role="status" aria-live="polite">
      {keys.length ? <Keys binding={keys.join(" ")} /> : "Press a key…"}
    </span>
  );
}
