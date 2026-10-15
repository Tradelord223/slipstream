import { compose } from "../store/compose.ts";
import { getRoute } from "../store/route.ts";
import { ui } from "../store/ui.ts";
import type { CommandDef, Scope } from "./commands.ts";
import { eventKey, isEditable } from "./keys.ts";
import { isChordPrefix, lookup } from "./registry.ts";

const CHORD_TIMEOUT = 1000;

function activeScopes(target: EventTarget | null): Scope[] {
  const el = target instanceof Element ? target : null;
  if (compose.get().open && el?.closest("[data-compose]")) return ["compose", "global"];
  const route = getRoute();
  if (route.name === "thread") return ["thread", "global"];
  if (route.name === "mail") return ["list", "global"];
  if (route.name === "review") return ["review", "page", "global"];
  return ["page", "global"];
}

/** One window-level listener. Components that own a key (menus, pickers) handle it first and stop it bubbling. */
export function installKeys(): () => void {
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearChord = () => {
    pending = null;
    clearTimeout(timer);
    if (ui.get().chord) ui.set({ chord: null });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const { palette, remind, shortcuts, capturing } = ui.get();
    if (palette || remind || shortcuts || capturing) return;
    const key = eventKey(e);
    if (!key) return;

    const target = e.target;
    const editable = isEditable(target);
    const scopes = activeScopes(target);
    const inCompose = scopes[0] === "compose";
    const hasMod = /(^|\+)(mod|ctrl)(\+|$)/.test(key) && key !== "mod" && key !== "ctrl";

    // Typing: only shortcuts with a modifier (and Esc in the composer) are allowed through.
    if (editable && !hasMod && !(inCompose && key === "escape")) {
      clearChord();
      return;
    }
    // Enter and Space belong to whatever button or link has focus.
    if ((key === "enter" || key === "space") && target instanceof HTMLElement && target.closest("button, a[href], select, summary, [role='button'], [role='tab']")) {
      return;
    }

    const usable = (cmds: CommandDef[]) =>
      cmds.filter((c) => c.scopes.some((s) => scopes.includes(s)) && (!c.when || c.when()) && (!c.needsListFocus || listHasFocus()));
    // In a plain input (search, settings fields) only global modifier shortcuts apply.
    const allow = (cmds: CommandDef[]) => {
      const u = usable(cmds);
      return editable && !inCompose ? u.filter((c) => c.scopes.includes("global")) : u;
    };
    const first = (cmds: CommandDef[]) => {
      // A scope-specific binding beats a global one with the same keys.
      for (const s of scopes) {
        const hit = cmds.find((c) => c.scopes.includes(s));
        if (hit) return hit;
      }
      return cmds[0];
    };

    const run = (cmd: CommandDef) => {
      e.preventDefault();
      if (e.repeat && !cmd.repeat) return;
      try {
        cmd.run();
      } catch (err) {
        console.error(`[slipstream] command ${cmd.id} failed`, err);
      }
    };

    if (pending) {
      const chord = `${pending} ${key}`;
      const hit = first(allow(lookup(chord)));
      clearChord();
      if (hit) {
        run(hit);
        return;
      }
    }

    const hit = first(allow(lookup(key)));
    if (hit) {
      clearChord();
      run(hit);
      return;
    }

    if (!editable && !hasMod && isChordPrefix(key)) {
      e.preventDefault();
      pending = key;
      ui.set({ chord: key });
      clearTimeout(timer);
      timer = setTimeout(clearChord, CHORD_TIMEOUT);
    }
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

function listHasFocus(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || Boolean(a.closest("[data-list-root]"));
}
