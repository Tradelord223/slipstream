export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

const NAMED: Record<string, string> = {
  Enter: "enter", Escape: "escape", Tab: "tab", ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  " ": "space", Backspace: "backspace", Delete: "delete", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
};

const CODES: Record<string, string> = {
  Comma: ",", Period: ".", Semicolon: ";", Slash: "/", Backslash: "\\", Minus: "-", Equal: "=", BracketLeft: "[",
  BracketRight: "]", Quote: "'", Backquote: "`",
};

/** Turn a keydown into a binding string like "mod+shift+enter", "j", "shift+j", "#", "ctrl+1". null for bare modifiers. */
export function eventKey(e: KeyboardEvent): string | null {
  if (["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "Dead", "Process"].includes(e.key)) return null;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const ctrl = isMac && e.ctrlKey;
  const alt = e.altKey;
  let key: string;
  if (NAMED[e.key]) key = NAMED[e.key]!;
  else if (mod || ctrl || alt) {
    const m = /^Key([A-Z])$/.exec(e.code);
    const d = /^Digit(\d)$/.exec(e.code);
    const n = /^Numpad(\d)$/.exec(e.code);
    key = m ? m[1]!.toLowerCase() : d ? d[1]! : n ? n[1]! : (CODES[e.code] ?? e.key.toLowerCase());
  } else key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();

  const letterLike = /^[a-z]$/.test(key) || key in { enter: 1, escape: 1, tab: 1, up: 1, down: 1, left: 1, right: 1, space: 1, backspace: 1 };
  const withCombo = mod || ctrl || alt;
  const parts: string[] = [];
  if (mod) parts.push("mod");
  if (ctrl) parts.push("ctrl");
  if (alt) parts.push("alt");
  if (e.shiftKey && (letterLike || withCombo)) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

const GLYPHS: Record<string, string> = {
  enter: "↵", escape: "Esc", tab: "Tab", up: "↑", down: "↓", left: "←", right: "→", space: "Space", backspace: "⌫",
  delete: "Del", home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn",
};

/** Keycap labels for one binding: "mod+shift+k" → ["⌘", "⇧", "K"]; "g i" → ["G", "I"]. */
export function keycaps(binding: string): string[] {
  return binding
    .split(" ")
    .flatMap((chunk) => chunk.split(/\+(?!$)/))
    .map((p) => {
      if (p === "mod") return isMac ? "⌘" : "Ctrl";
      if (p === "ctrl") return isMac ? "⌃" : "Ctrl";
      if (p === "alt") return isMac ? "⌥" : "Alt";
      if (p === "shift") return isMac ? "⇧" : "Shift";
      if (GLYPHS[p]) return GLYPHS[p]!;
      return p.length === 1 ? p.toUpperCase() : p;
    });
}

export function bindingLabel(binding: string): string {
  return keycaps(binding).join(isMac ? "" : "+");
}

export function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range", "color", "file"].includes(type);
  }
  return false;
}
