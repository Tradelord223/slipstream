import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { sanitizeDraftHtml } from "../lib/emailHtml.ts";
import type { Snippet } from "../types.ts";
import { edit, registerEditor, insertSnippet } from "../store/compose.ts";
import { useSession } from "../store/session.ts";
import { fuzzyFilter } from "../lib/fuzzy.ts";
import { htmlToText } from "../lib/format.ts";

export interface EditorApi {
  saveSelection(): void;
  restoreSelection(): void;
  openLink(): void;
}

interface Trigger {
  query: string;
  range: Range;
  rect: { left: number; top: number; bottom: number };
}

/** The body: a contenteditable that reports its HTML and offers `;` snippets at the caret. */
export const ComposeEditor = forwardRef<EditorApi, { initialHtml: string; focusAtStart?: boolean; onLink: () => void }>(function ComposeEditor(
  { initialHtml, focusAtStart, onLink },
  ref,
) {
  const el = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const snippets = useSession((s) => s.snippets);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [active, setActive] = useState(0);

  const matches = trigger ? fuzzyFilter(snippets, trigger.query, (s) => s.name).slice(0, 6) : [];

  const push = () => {
    if (el.current) edit({ bodyHtml: el.current.innerHTML });
  };

  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && el.current?.contains(sel.anchorNode)) saved.current = sel.getRangeAt(0).cloneRange();
  };
  const restoreSelection = () => {
    el.current?.focus();
    const sel = window.getSelection();
    if (saved.current && sel) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    }
  };

  useImperativeHandle(ref, () => ({ saveSelection, restoreSelection, openLink: onLink }));

  // Mount with the stored HTML; later edits flow out through `push`, never back in.
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    node.innerHTML = sanitizeDraftHtml(initialHtml);
    if (focusAtStart) {
      node.focus();
      const range = document.createRange();
      range.setStart(node, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    registerEditor({
      focus: () => restoreSelection(),
      insertHtml(html, replace) {
        node.focus();
        const sel = window.getSelection();
        if (replace && sel) {
          sel.removeAllRanges();
          sel.addRange(replace);
        } else if (saved.current && sel && !node.contains(sel.anchorNode)) {
          sel.removeAllRanges();
          sel.addRange(saved.current);
        }
        document.execCommand("insertHTML", false, html);
        push();
      },
      prependHtml(html) {
        node.insertAdjacentHTML("afterbegin", html);
        push();
      },
    });
    return () => registerEditor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkTrigger = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed || !el.current?.contains(sel.anchorNode)) return setTrigger(null);
    const node = sel.anchorNode!;
    if (node.nodeType !== Node.TEXT_NODE) return setTrigger(null);
    const before = (node.textContent ?? "").slice(0, sel.anchorOffset);
    const m = /(^|\s);([\w-]*)$/.exec(before);
    if (!m) return setTrigger(null);
    const range = document.createRange();
    range.setStart(node, sel.anchorOffset - m[2]!.length - 1);
    range.setEnd(node, sel.anchorOffset);
    const caret = sel.getRangeAt(0).getBoundingClientRect();
    const box = el.current.getBoundingClientRect();
    setTrigger({
      query: m[2]!,
      range,
      rect: { left: caret.left || box.left, top: caret.top || box.top, bottom: caret.bottom || box.top + 20 },
    });
    setActive(0);
  };

  const insert = (s: Snippet) => {
    if (!trigger) return;
    const range = trigger.range;
    setTrigger(null);
    insertSnippet(s, range);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (trigger && matches.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        insert(matches[active]!);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setTrigger(null);
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const html = e.clipboardData.getData("text/html");
    if (html) document.execCommand("insertHTML", false, sanitizeDraftHtml(html));
    else document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  };

  return (
    <>
      <div
        ref={el}
        className="editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Message body"
        data-compose-focus
        spellCheck
        onInput={() => {
          push();
          checkTrigger();
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          if (e.key.startsWith("Arrow") || e.key === "Backspace") checkTrigger();
        }}
        onBlur={saveSelection}
        onPaste={onPaste}
      />
      {trigger && matches.length > 0 && (
        <ul className="snippet-pop" role="listbox" aria-label="Snippets" style={{ left: Math.min(trigger.rect.left, window.innerWidth - 300), top: trigger.rect.bottom + 6 }}>
          {matches.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === active} className={i === active ? "active" : ""} onMouseDown={(e) => (e.preventDefault(), insert(s))}>
              <span className="snippet-name">{s.name}</span>
              <span className="snippet-preview">{htmlToText(s.bodyHtml).slice(0, 70)}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
});
