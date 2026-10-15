import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api.ts";
import { parseAddress } from "../lib/compose.ts";
import type { Address, Contact } from "../types.ts";
import { Icon } from "./Icon.tsx";

export function RecipientField({
  label,
  value,
  onChange,
  autoFocus,
  primary,
  trailing,
}: {
  label: string;
  value: Address[];
  onChange: (next: Address[]) => void;
  autoFocus?: boolean;
  primary?: boolean;
  trailing?: React.ReactNode;
}) {
  const [text, setText] = useState("");
  const [options, setOptions] = useState<Contact[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  // Suggestions follow the text, minus people already added.
  useEffect(() => {
    const q = text.trim().replace(/^"|"$/g, "");
    if (q.length < 1) {
      setOptions([]);
      setOpen(false);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const { contacts } = await api.contacts(q, ctl.signal);
        const have = new Set(value.map((a) => a.email));
        const next = contacts.filter((c) => !have.has(c.email.toLowerCase()));
        setOptions(next);
        setActive(0);
        setOpen(next.length > 0);
      } catch {
        /* suggestions are optional */
      }
    }, 90);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [text, value]);

  const add = (addrs: Address[]) => {
    if (addrs.length === 0) return;
    const have = new Set(value.map((a) => a.email));
    const fresh = addrs.filter((a) => !have.has(a.email));
    if (fresh.length) onChange([...value, ...fresh]);
    setText("");
    setOptions([]);
    setOpen(false);
  };

  const commitText = (): boolean => {
    const parts = text.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
    const parsed = parts.map(parseAddress).filter((a): a is Address => Boolean(a));
    if (parsed.length === 0) return false;
    add(parsed);
    return true;
  };

  const choose = (c: Contact) => add([{ name: c.name, email: c.email.toLowerCase() }]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (open && options.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        choose(options[active]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        return;
      }
    }
    if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "," || e.key === ";") {
      if (text.trim() && commitText()) e.preventDefault();
      return;
    }
    if (e.key === "Tab" && text.trim()) {
      if (commitText()) e.preventDefault();
      return;
    }
    if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className="recipient-row">
      <label className="recipient-label" onClick={() => input.current?.focus()}>
        {label}
      </label>
      <div className="recipient-box" onClick={() => input.current?.focus()}>
        {value.map((a) => (
          <span className="token" key={a.email} title={a.email}>
            {a.name || a.email}
            <button type="button" tabIndex={-1} aria-label={`Remove ${a.name || a.email}`} onClick={() => onChange(value.filter((x) => x.email !== a.email))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          className="recipient-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (text.trim()) commitText();
            setTimeout(() => setOpen(false), 120);
          }}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text");
            if (/[,;\n]/.test(pasted)) {
              const parsed = pasted.split(/[,;\n]/).map((p) => parseAddress(p.trim())).filter((a): a is Address => Boolean(a));
              if (parsed.length) {
                e.preventDefault();
                add(parsed);
              }
            }
          }}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={label}
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          data-recipient-input={primary ? "" : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        {open && (
          <ul className="suggest" id={listId} role="listbox" aria-label={`${label} suggestions`}>
            {options.map((c, i) => (
              <li key={c.email} id={`${listId}-${i}`} role="option" aria-selected={i === active} className={i === active ? "active" : ""} onMouseDown={(e) => (e.preventDefault(), choose(c))}>
                <span className="suggest-name">{c.name || c.email}</span>
                {c.name && <span className="suggest-email">{c.email}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {trailing}
    </div>
  );
}
