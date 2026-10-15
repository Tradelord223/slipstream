import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyText } from "../lib/clipboard.ts";
import { toast } from "../store/toasts.ts";
import { Icon } from "./Icon.tsx";

export function CopyButton({ text, label = "Copy", what, onCopied }: { text: string; label?: string; what?: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      onCopied?.();
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } else toast.error("Couldn't copy. Select the text and copy it.");
  };
  return (
    <button type="button" className="btn btn-sm copy-btn" onClick={() => void copy()} aria-label={what ? `${label} ${what}` : label}>
      <Icon name={copied ? "check" : "copy"} />
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}

/** A read-only value with a Copy button: tokens, URLs, secrets. */
export function CopyField({ value, label, onCopied }: { value: string; label: string; onCopied?: () => void }) {
  return (
    <div className="copy-field">
      <input className="field num" readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
      <CopyButton text={value} what={label.toLowerCase()} onCopied={onCopied} />
    </div>
  );
}

/** A titled, copyable block of text such as a command or a config file. */
export function Snippet({ title, hint, text, onCopied }: { title: string; hint?: ReactNode; text: string; onCopied?: () => void }) {
  return (
    <div className="snip">
      <div className="snip-head">
        <div className="snip-heading">
          <div className="snip-title">{title}</div>
          {hint && <div className="snip-hint">{hint}</div>}
        </div>
        <CopyButton text={text} what={title} onCopied={onCopied} />
      </div>
      <pre className="snip-code" tabIndex={0} aria-label={title}>
        {text}
      </pre>
    </div>
  );
}
