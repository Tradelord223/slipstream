import { useEffect, useMemo, useRef, useState } from "react";
import { COMMANDS } from "../keys/commands.ts";
import { bindingsOf } from "../keys/registry.ts";
import { fuzzyScore } from "../lib/fuzzy.ts";
import { act } from "../store/actions.ts";
import { cachedThread } from "../store/threads.ts";
import { list, threadById } from "../store/list.ts";
import { getMeToZero, goView } from "../store/nav.ts";
import { getRoute, navigate } from "../store/route.ts";
import { setAccountFilter, signOut, updateSettings, useSession } from "../store/session.ts";
import { api } from "../api.ts";
import { openAssistant } from "../store/assistant.ts";
import { askAssistant } from "../store/cloud.ts";
import { useAssistantName, useCanRun } from "../store/engines.ts";
import { useLabels } from "../store/labels.ts";
import { toast } from "../store/toasts.ts";
import { closePalette, useUi, type PaletteMode } from "../store/ui.ts";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";
import { Keys } from "./Keycap.tsx";
import { LabelDot } from "./labels/LabelChip.tsx";

interface Item {
  id: string;
  title: string;
  group: string;
  binding?: string;
  /** A label's colour, shown as a dot; undefined for rows that aren't labels. */
  color?: string | null;
  /** In the multi-select label picker: whether the label is on. */
  checked?: boolean;
  run: () => void;
}

/** The labels every one of these conversations already has, lower-cased. */
function commonLabels(ids: string[]): Set<string> {
  const sets = ids.map((id) => {
    const have: string[] = (threadById(id) ?? cachedThread(id)?.thread)?.labels ?? [];
    return new Set(have.map((l) => l.toLowerCase()));
  });
  const first = sets[0];
  return first ? new Set([...first].filter((l) => sets.every((s) => s.has(l)))) : new Set();
}

const PLACEHOLDER: Record<PaletteMode, string> = {
  root: "Type a command or search",
  label: "Add a label",
  move: "Move to",
  removeLabel: "Remove which label",
  goLabel: "Go to label",
  account: "Switch account",
};

export function CommandPalette() {
  const palette = useUi((s) => s.palette);
  if (!palette) return null;
  return <Palette mode={palette.mode} ids={palette.ids} />;
}

function Palette({ mode: initialMode, ids }: { mode: PaletteMode; ids: string[] }) {
  const [mode, setMode] = useState<PaletteMode>(initialMode);
  const [zero, setZero] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const session = useSession((s) => s);
  const connected = useCanRun() && session.settings.assistant === "on";
  const assistantLabel = useAssistantName();
  const labelInfos = useLabels();
  // The label picker toggles several labels, then applies them together.
  const initialPicked = useRef<Set<string>>(initialMode === "label" ? commonLabels(ids) : new Set()).current;
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initialPicked));
  const [typedNames, setTypedNames] = useState<Map<string, string>>(new Map());

  const items = useMemo<Item[]>(() => {
    const run = (fn: () => void): (() => void) => () => {
      closePalette();
      setTimeout(fn, 0);
    };
    const labels = labelInfos.map((l) => l.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const colorOf = new Map(labelInfos.map((l) => [l.name.toLowerCase(), l.color]));
    const out: Item[] = [];
    const toggle = (name: string) => {
      const key = name.toLowerCase();
      if (!labels.some((l) => l.toLowerCase() === key)) setTypedNames((m) => new Map(m).set(key, name));
      setPicked((cur) => {
        const next = new Set(cur);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    };

    const labelItems = (group: string, pick: (name: string) => void, source: string[], create = true): Item[] => {
      const rows: Item[] = source.map((l) => ({ id: `lbl:${l}`, title: l, group, color: colorOf.get(l.toLowerCase()) ?? null, run: run(() => pick(l)) }));
      const typed = q.trim();
      if (create && typed && !source.some((l) => l.toLowerCase() === typed.toLowerCase())) {
        rows.push({ id: "create", title: `Create label “${typed}”`, group, run: run(() => pick(typed)) });
      }
      return rows;
    };

    if (zero) {
      const go = (days: number, keep: boolean, label: string) => run(() => void getMeToZero({ olderThanDays: days, keepStarred: keep }, label));
      return [
        { id: "z1", title: "Everything except starred", group: "Get me to zero", run: go(0, true, "Inbox cleared") },
        { id: "z2", title: "Everything, starred too", group: "Get me to zero", run: go(0, false, "Inbox cleared") },
        { id: "z3", title: "Older than a week", group: "Get me to zero", run: go(7, true, "Cleared the older mail") },
        { id: "z4", title: "Older than a month", group: "Get me to zero", run: go(30, true, "Cleared the older mail") },
      ];
    }
    if (mode === "label") {
      const rows: Item[] = labels.map((l) => ({ id: `lbl:${l}`, title: l, group: "Label", color: colorOf.get(l.toLowerCase()) ?? null, checked: picked.has(l.toLowerCase()), run: () => toggle(l) }));
      // Names typed into the box that don't exist yet, once chosen, stay listed so they can be unchosen.
      for (const key of picked) {
        const name = typedNames.get(key);
        if (name && !labels.some((l) => l.toLowerCase() === key)) rows.unshift({ id: `lbl:${name}`, title: name, group: "New", color: null, checked: true, run: () => toggle(name) });
      }
      const typed = q.trim();
      if (typed && !rows.some((r) => r.title.toLowerCase() === typed.toLowerCase())) {
        rows.push({ id: "create", title: `Create “${typed}”`, group: "Label", checked: picked.has(typed.toLowerCase()), run: () => toggle(typed) });
      }
      return rows;
    }
    if (mode === "move") {
      const system: Item[] = [
        { id: "inbox", title: "Inbox", group: "Move to", run: run(() => void act.notDone({ ids })) },
        { id: "done", title: "Done", group: "Move to", run: run(() => void act.done({ ids })) },
        { id: "trash", title: "Trash", group: "Move to", run: run(() => void act.trash({ ids })) },
        { id: "spam", title: "Spam", group: "Move to", run: run(() => void act.spam({ ids })) },
      ];
      return [...system, ...labelItems("Move to label", (n) => void act.moveToLabel(n, { ids }), labels)];
    }
    if (mode === "removeLabel") {
      const have = new Map<string, string>();
      for (const id of ids) for (const l of (threadById(id) ?? cachedThread(id)?.thread)?.labels ?? []) have.set(l.toLowerCase(), l);
      return labelItems("Remove label", (n) => void act.removeLabel(n, { ids }), [...have.values()], false);
    }
    if (mode === "goLabel") return labelItems("Go to label", (n) => goView({ kind: "label", name: n }), labels, false);

    // Root: every command, then places, settings, theme.
    const toBinding = (cmdId: string) => {
      const c = COMMANDS.find((x) => x.id === cmdId);
      return c ? bindingsOf(c, session.settings.keymap)[0] : undefined;
    };
    const here = getRoute().name === "thread" ? "thread" : getRoute().name === "mail" ? "list" : "page";
    const order = ["Triage", "Write", "Go to", "Autopilot", "Move", "Select", "Compose", "General"];
    const rankOf = (g: string) => (order.includes(g) ? order.indexOf(g) : 99);
    const ranked = [...COMMANDS].sort((a, b) => rankOf(a.group) - rankOf(b.group));
    for (const c of ranked) {
      if (c.noPalette) continue;
      if (!c.scopes.some((x) => x === here || x === "global" || x === "compose")) continue;
      if (c.when && !c.when()) continue;
      if (c.id === "compose.replyAllList") continue;
      if (c.id === "compose.ai" && !session.features.ai) continue;
      out.push({ id: c.id, title: c.title, group: c.group, binding: bindingsOf(c, session.settings.keymap)[0], run: run(c.run) });
    }
    for (const s of session.splits) out.push({ id: `split:${s.id}`, title: `Go to ${s.name}`, group: "Go to", run: run(() => goView({ kind: "inbox", splitId: s.id })) });
    for (const l of labels) out.push({ id: `label:${l}`, title: `Go to label ${l}`, group: "Go to", color: colorOf.get(l.toLowerCase()) ?? null, run: run(() => goView({ kind: "label", name: l })) });
    out.push({ id: "zero", title: "Get me to zero…", group: "Triage", run: () => (setZero(true), setQ(""), setActive(0)) });
    out.push({ id: "acct:all", title: "Switch to all inboxes", group: "Accounts", binding: toBinding("account.1"), run: run(() => setAccountFilter(null)) });
    session.accounts.forEach((a, i) =>
      out.push({ id: `acct:${a.id}`, title: `Switch to ${a.email}`, group: "Accounts", binding: i < 8 ? `ctrl+${i + 2}` : undefined, run: run(() => setAccountFilter(a.id)) }),
    );
    out.push({ id: "sync", title: "Sync now", group: "Accounts", run: run(() => void Promise.all(session.accounts.map((a) => api.syncAccount(a.id))).then(() => toast.info("Syncing"))) });
    for (const [label, section] of [["General", "general"], ["Accounts", "accounts"], ["Splits", "splits"], ["Labels", "labels"], ["Helpers", "helpers"], ["Snippets", "snippets"], ["Shortcuts", "shortcuts"], ["Team", "team"], ["AI & agents", "ai"], ["Models & accounts", "models"], ["Connect an assistant", "connect"], ["Privacy & safety", "privacy"]] as const) {
      out.push({ id: `settings:${section}`, title: `Settings: ${label}`, group: "Settings", run: run(() => navigate(`/settings/${section}`)) });
    }
    if (session.mode === "team") out.push({ id: "signout", title: "Sign out", group: "Accounts", run: run(() => void signOut()) });
    out.push({ id: "theme:dark", title: "Theme: Dark", group: "Appearance", run: run(() => void updateSettings({ theme: "dark" })) });
    out.push({ id: "theme:light", title: "Theme: Light", group: "Appearance", run: run(() => void updateSettings({ theme: "light" })) });
    out.push({ id: "theme:system", title: "Theme: Match system", group: "Appearance", run: run(() => void updateSettings({ theme: "system" })) });
    out.push({
      id: "density",
      title: session.settings.density === "compact" ? "Density: Comfortable" : "Density: Compact",
      group: "Appearance",
      run: run(() => void updateSettings({ density: session.settings.density === "compact" ? "comfortable" : "compact" })),
    });
    if (session.workspace && getRoute().name === "thread") {
      const id = (getRoute() as { id: string }).id;
      out.push({
        id: "share",
        title: "Share with team",
        group: "Team",
        run: run(() => void api.shareThread(id).then(() => toast.info("Shared with your team")).catch((e: Error) => toast.error(e.message))),
      });
    }
    return out;
  }, [mode, zero, q, ids, session, labelInfos, picked, typedNames]);

  const shown = useMemo(() => {
    const query = q.trim();
    if (!query || zero) return items;
    const ranked = rank(items, query);
    if (mode !== "root" || !connected) return ranked;
    // Typing anything also offers to hand it to the assistant. It's the default only when no command matches,
    // so Enter on a typo never starts a paid run by surprise.
    const ask: Item = {
      id: "ask-claude",
      title: `Ask ${assistantLabel}: ${query}`,
      group: assistantLabel,
      run: () => {
        closePalette();
        openAssistant({ runId: null });
        void askAssistant(query).then((run) => run && openAssistant({ runId: run.id }));
      },
    };
    return ranked.length ? [...ranked, ask] : [ask];
  }, [items, q, mode, zero, connected, assistantLabel]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /** Space types into the box when a label's name continues with a space, and picks the row otherwise. */
  const spaceBelongsToName = () => {
    const typed = q.toLowerCase();
    return typed.length > 0 && labelInfos.some((l) => l.name.toLowerCase().startsWith(`${typed} `)) || /\s$/.test(q);
  };

  /** Enter: apply every change made with Space; if there were none, apply the highlighted label. */
  const applyLabels = () => {
    const nameOf = (key: string) => labelInfos.find((l) => l.name.toLowerCase() === key)?.name ?? typedNames.get(key) ?? key;
    let adds = [...picked].filter((k) => !initialPicked.has(k)).map(nameOf);
    const removes = [...initialPicked].filter((k) => !picked.has(k)).map(nameOf);
    if (adds.length === 0 && removes.length === 0) {
      const row = shown[active];
      if (!row) return;
      const name = row.id === "create" ? q.trim() : row.title;
      if (!initialPicked.has(name.toLowerCase())) adds = [name];
    } else if (shown[active]?.id === "create" && q.trim() && !picked.has(q.trim().toLowerCase())) {
      adds.push(q.trim());
    }
    closePalette();
    setTimeout(() => {
      for (const n of adds) void act.addLabel(n, { ids });
      for (const n of removes) void act.removeLabel(n, { ids });
    }, 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || (e.ctrlKey && (e.key === "n" || e.key === "p"))) {
      e.preventDefault();
      const dir = e.key === "ArrowDown" || e.key === "n" ? 1 : -1;
      setActive((a) => (shown.length ? (a + dir + shown.length) % shown.length : 0));
    } else if (mode === "label" && !zero && e.key === " " && shown[active]?.checked !== undefined && shown[active]!.id !== "create" && !spaceBelongsToName()) {
      e.preventDefault();
      shown[active]!.run();
    } else if (e.key === "Enter" && mode === "label" && !zero) {
      e.preventDefault();
      applyLabels();
    } else if (e.key === "Enter") {
      e.preventDefault();
      shown[active]?.run();
    } else if (e.key === "Backspace" && !q && (mode !== "root" || zero)) {
      e.preventDefault();
      setMode("root");
      setZero(false);
    } else if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      closePalette();
    }
  };

  const placeholder = zero ? "How much should go?" : PLACEHOLDER[mode];
  let lastGroup = "";
  return (
    <Dialog label="Command palette" onClose={closePalette} placement="top" className="dialog-palette" initialFocus="input">
      <div className="palette" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            value={q}
            onChange={(e) => (setQ(e.target.value), setActive(0))}
            placeholder={placeholder}
            aria-label={placeholder}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[active] ? `pal-${shown[active]!.id}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <ul id="palette-list" className="palette-list" role="listbox" aria-multiselectable={mode === "label" || undefined} ref={listRef}>
          {shown.map((it, i) => {
            const header = it.group !== lastGroup && !q.trim() ? it.group : null;
            lastGroup = it.group;
            return (
              <li key={it.id} role="presentation">
                {header && <div className="palette-group">{header}</div>}
                <div
                  id={`pal-${it.id}`}
                  data-idx={i}
                  role="option"
                  aria-selected={it.checked !== undefined ? it.checked : i === active}
                  className={`palette-row ${i === active ? "active" : ""} ${it.id === "ask-claude" ? "ask" : ""}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={it.run}
                >
                  {it.id === "ask-claude" && <Icon name="sparkle" size={15} />}
                  {it.checked !== undefined && (
                    <span className="pal-check" data-on={it.checked || undefined} aria-hidden="true">
                      {it.checked && <Icon name="check" size={12} />}
                    </span>
                  )}
                  {it.color !== undefined && <LabelDot color={it.color} />}
                  <span className="palette-title">{it.title}</span>
                  {q.trim() && <span className="palette-hint">{it.group}</span>}
                  {it.binding && <Keys binding={it.binding} />}
                </div>
              </li>
            );
          })}
          {shown.length === 0 && <li className="picker-empty">Nothing matches “{q}”.</li>}
        </ul>
        {mode === "label" && !zero && (
          <div className="palette-foot">
            <span>
              <Keys binding="space" /> select
            </span>
            <span>
              <Keys binding="enter" /> apply
            </span>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function rank(items: Item[], query: string): Item[] {
  const scored: { it: Item; s: number }[] = [];
  for (const it of items) {
    const s = fuzzyScore(query, it.title) ?? (fuzzyScore(query, `${it.group} ${it.title}`) ?? null);
    if (s !== null) scored.push({ it, s });
  }
  return scored.sort((a, b) => b.s - a.s).map((x) => x.it);
}

void list;
