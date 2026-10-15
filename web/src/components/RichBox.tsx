import { useEffect, useRef } from "react";
import { sanitizeDraftHtml } from "../lib/emailHtml.ts";
import { Icon } from "./Icon.tsx";

/** A small rich-text field for signatures and snippets. Reports HTML when it loses focus. */
export function RichBox({
  label,
  html,
  onCommit,
  minHeight = 96,
}: {
  label: string;
  html: string;
  onCommit: (html: string) => void;
  minHeight?: number;
}) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (el.current && document.activeElement !== el.current) el.current.innerHTML = sanitizeDraftHtml(html);
  }, [html]);

  const exec = (cmd: string) => {
    el.current?.focus();
    document.execCommand(cmd);
  };

  return (
    <div className="richbox">
      <div className="richbox-bar" role="toolbar" aria-label={`${label} formatting`}>
        <button type="button" className="icon-btn" aria-label="Bold" onClick={() => exec("bold")}>
          <b>B</b>
        </button>
        <button type="button" className="icon-btn" aria-label="Italic" onClick={() => exec("italic")}>
          <i>I</i>
        </button>
        <button type="button" className="icon-btn" aria-label="Bulleted list" onClick={() => exec("insertUnorderedList")}>
          <Icon name="menu" />
        </button>
      </div>
      <div
        ref={el}
        className="richbox-edit"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        style={{ minHeight }}
        onBlur={() => el.current && onCommit(sanitizeDraftHtml(el.current.innerHTML))}
      />
    </div>
  );
}
