import { useMemo, useState } from "react";
import { COMMANDS } from "../keys/commands.ts";
import { bindingsOf } from "../keys/registry.ts";
import { fuzzyScore } from "../lib/fuzzy.ts";
import { useSession } from "../store/session.ts";
import { ui, useUi } from "../store/ui.ts";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";
import { Keys } from "./Keycap.tsx";

const GROUP_ORDER = ["Move", "Triage", "Select", "Review", "Write", "Compose", "Go to", "General", "Accounts"];

export function ShortcutsSheet() {
  const open = useUi((s) => s.shortcuts);
  if (!open) return null;
  return <Sheet />;
}

function Sheet() {
  const keymap = useSession((s) => s.settings.keymap);
  const ai = useSession((s) => s.features.ai);
  const [q, setQ] = useState("");
  const close = () => ui.set({ shortcuts: false });

  const groups = useMemo(() => {
    // The arrow keys duplicate j and k; list them on the same row.
    const alias: Record<string, string> = { "nav.next": "nav.nextArrow", "nav.prev": "nav.prevArrow", "review.next": "review.nextArrow", "review.prev": "review.prevArrow" };
    const hidden = new Set(["nav.nextArrow", "nav.prevArrow", "review.nextArrow", "review.prevArrow", "compose.replyAllList"]);
    const rows = COMMANDS.filter((c) => (c.id !== "compose.ai" || ai) && !c.id.startsWith("account.") && !hidden.has(c.id))
      .map((c) => {
        const extra = alias[c.id] ? COMMANDS.find((x) => x.id === alias[c.id]) : undefined;
        return { c, bindings: [...bindingsOf(c, keymap), ...(extra ? bindingsOf(extra, keymap) : [])] };
      })
      .filter((r) => r.bindings.length > 0)
      .filter((r) => !q.trim() || fuzzyScore(q, `${r.c.title} ${r.c.group} ${r.bindings.join(" ")}`) !== null);
    const by = new Map<string, typeof rows>();
    for (const r of rows) by.set(r.c.group, [...(by.get(r.c.group) ?? []), r]);
    return [...by.entries()].sort((a, b) => GROUP_ORDER.indexOf(a[0]) - GROUP_ORDER.indexOf(b[0]));
  }, [q, keymap, ai]);

  return (
    <Dialog label="Keyboard shortcuts" onClose={close} className="dialog-sheet" placement="top" initialFocus="input">
      <div className="sheet-head">
        <h3>Keyboard shortcuts</h3>
        <button className="icon-btn" aria-label="Close" onClick={close}>
          <Icon name="x" />
        </button>
      </div>
      <div className="palette-input">
        <Icon name="search" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search shortcuts" aria-label="Search shortcuts" autoComplete="off" />
      </div>
      <div className="sheet-body">
        {groups.map(([group, rows]) => (
          <section key={group} className="sheet-group">
            <h4>{group}</h4>
            <ul role="list">
              {rows.map(({ c, bindings }) => (
                <li key={c.id}>
                  <span>{c.title}</span>
                  <span className="sheet-keys">
                    {bindings.map((b) => (
                      <Keys key={b} binding={b} />
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && <div className="picker-empty">No shortcuts match.</div>}
      </div>
    </Dialog>
  );
}
