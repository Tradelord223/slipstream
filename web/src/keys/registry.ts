import { session } from "../store/session.ts";
import { COMMANDS, type CommandDef } from "./commands.ts";

/** Bindings for a command: the user's remap if there is one, otherwise the defaults. */
export function bindingsOf(cmd: CommandDef, keymap: Record<string, string>): string[] {
  const override = keymap[cmd.id];
  if (override === undefined) return cmd.keys;
  return override ? [override] : [];
}

let cachedKeymap: Record<string, string> | null = null;
let table = new Map<string, CommandDef[]>();
let prefixes = new Set<string>();

function rebuild(keymap: Record<string, string>) {
  cachedKeymap = keymap;
  table = new Map();
  prefixes = new Set();
  for (const cmd of COMMANDS) {
    for (const b of bindingsOf(cmd, keymap)) {
      const list = table.get(b) ?? [];
      list.push(cmd);
      table.set(b, list);
      const space = b.indexOf(" ");
      if (space > 0) prefixes.add(b.slice(0, space));
    }
  }
}

export function lookup(binding: string): CommandDef[] {
  const keymap = session.get().settings.keymap;
  if (keymap !== cachedKeymap) rebuild(keymap);
  return table.get(binding) ?? [];
}

export function isChordPrefix(key: string): boolean {
  lookup("");
  return prefixes.has(key);
}

/** Commands that share a binding in overlapping scopes, so the Shortcuts settings can warn. */
export function conflictsFor(binding: string, exceptId: string): CommandDef[] {
  const keymap = session.get().settings.keymap;
  if (keymap !== cachedKeymap) rebuild(keymap);
  const mine = COMMANDS.find((c) => c.id === exceptId);
  return (table.get(binding) ?? []).filter((c) => c.id !== exceptId && (!mine || c.scopes.some((s) => mine.scopes.includes(s))));
}

export function visibleCommands(): CommandDef[] {
  return COMMANDS.filter((c) => !c.when || c.when());
}
