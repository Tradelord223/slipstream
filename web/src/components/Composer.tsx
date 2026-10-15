import { useEffect, useRef, useState } from "react";
import { bytes, htmlToText } from "../lib/format.ts";
import { fuzzyFilter } from "../lib/fuzzy.ts";
import { useDismiss } from "../lib/hooks.ts";
import { Keys } from "./Keycap.tsx";
import { ComposeEditor, type EditorApi } from "./ComposeEditor.tsx";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";
import { RecipientField } from "./RecipientField.tsx";
import {
  attachFiles, closeCompose, compose, composeBus, discardDraft, edit, insertSnippet, removeAttachment, sendCompose, sendLater, useCompose,
} from "../store/compose.ts";
import { useSession } from "../store/session.ts";

export type Placement = "dock" | "modal" | "inline" | "full";

export function Composer({ placement }: { placement: Placement }) {
  const key = useCompose((s) => s.editorKey);
  const inner = <ComposerBody key={key} placement={placement} />;
  if (placement === "modal") {
    return (
      <Dialog label="Compose" onClose={() => void closeCompose()} className="dialog-compose" initialFocus="[data-recipient-input], [data-compose-focus]">
        {inner}
      </Dialog>
    );
  }
  return inner;
}

function ComposerBody({ placement }: { placement: Placement }) {
  const s = useCompose((x) => x);
  const accounts = useSession((x) => x.accounts);
  const snippets = useSession((x) => x.snippets);
  const editor = useRef<EditorApi>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fromSelect = useRef<HTMLSelectElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const isReply = s.kind !== "new";

  // Commands that need this component's UI arrive over a tiny bus.
  useEffect(() => {
    const on = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      if (name === "attach") fileInput.current?.click();
      else if (name === "link") {
        editor.current?.saveSelection();
        setLinkOpen(true);
      } else if (name === "snippets") {
        editor.current?.saveSelection();
        setPickerOpen(true);
      } else if (name === "from") {
        fromSelect.current?.focus();
        try {
          fromSelect.current?.showPicker?.();
        } catch {
          /* focus is enough */
        }
      }
    };
    composeBus.addEventListener("compose", on);
    return () => composeBus.removeEventListener("compose", on);
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void attachFiles([...e.dataTransfer.files]);
  };

  const title = s.kind === "new" ? "New message" : s.subject || "Reply";
  const subjectVisible = placement !== "inline" || s.kind === "forward";
  const bodyFocus = isReply || s.to.length > 0;

  return (
    <section
      className={`composer composer-${placement} ${dragging ? "dragging" : ""}`}
      data-compose
      aria-label="Compose message"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      {placement !== "inline" && (
        <header className="composer-head">
          <span className="composer-title ellipsis">{title}</span>
          <span className="grow" />
          {placement !== "full" && (
            <button className="icon-btn" aria-label={placement === "modal" ? "Dock composer" : "Pop out composer"} title="Pop out (Shift+⌘P)" onClick={() => compose.set({ mode: placement === "modal" ? "dock" : "modal", inline: false })}>
              <Icon name={placement === "modal" ? "minimize" : "expand"} />
            </button>
          )}
          <button className="icon-btn" aria-label="Close composer, keep draft" title="Close (Esc)" onClick={() => void closeCompose()}>
            <Icon name="x" />
          </button>
        </header>
      )}

      <div className="composer-fields">
        {accounts.length > 1 && (
          <div className="recipient-row">
            <label className="recipient-label" htmlFor="compose-from">
              From
            </label>
            <select id="compose-from" ref={fromSelect} className="from-select" value={s.accountId} onChange={(e) => edit({ accountId: e.target.value })} data-from>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ? `${a.name} <${a.email}>` : a.email}
                </option>
              ))}
            </select>
          </div>
        )}
        <RecipientField
          label="To"
          value={s.to}
          onChange={(to) => edit({ to })}
          autoFocus={!bodyFocus}
          primary
          trailing={
            <span className="cc-toggles">
              {!s.showCc && (
                <button type="button" className="link-btn" onClick={() => edit({ showCc: true })} title="Add Cc (Shift+⌘C)">
                  Cc
                </button>
              )}
              {!s.showBcc && (
                <button type="button" className="link-btn" onClick={() => edit({ showBcc: true })} title="Add Bcc (Shift+⌘B)">
                  Bcc
                </button>
              )}
            </span>
          }
        />
        {s.showCc && <RecipientField label="Cc" value={s.cc} onChange={(cc) => edit({ cc })} autoFocus />}
        {s.showBcc && <RecipientField label="Bcc" value={s.bcc} onChange={(bcc) => edit({ bcc })} autoFocus />}
        {subjectVisible && (
          <div className="recipient-row">
            <label className="recipient-label" htmlFor="compose-subject">
              Subject
            </label>
            <input id="compose-subject" className="subject-input" value={s.subject} onChange={(e) => edit({ subject: e.target.value })} autoComplete="off" />
          </div>
        )}
      </div>

      <div className="composer-body">
        <ComposeEditor ref={editor} initialHtml={s.initialBody} focusAtStart={bodyFocus} onLink={() => setLinkOpen(true)} />
      </div>

      {s.attachments.length > 0 && (
        <ul className="attachments composer-attachments" aria-label="Attachments">
          {s.attachments.map((a) => (
            <li key={a.id}>
              <span className="attachment">
                <Icon name="paperclip" size={14} />
                <span className="attachment-name">{a.filename}</span>
                <span className="attachment-size num">{bytes(a.size)}</span>
                <button type="button" className="attachment-x" aria-label={`Remove ${a.filename}`} onClick={() => void removeAttachment(a.id)}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {linkOpen && <LinkBar editor={editor} onClose={() => setLinkOpen(false)} />}

      <footer className="composer-foot">
        <SendButton />
        <button type="button" className="icon-btn" aria-label="Attach files" title="Attach files (Shift+⌘U)" onClick={() => fileInput.current?.click()}>
          <Icon name="paperclip" />
        </button>
        <button type="button" className="icon-btn" aria-label="Insert snippet" title="Snippets (⌘;)" onClick={() => (editor.current?.saveSelection(), setPickerOpen(true))}>
          <Icon name="zap" />
        </button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => (void attachFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
        <label className="followup">
          <input type="checkbox" checked={s.followUpDays !== null} onChange={(e) => edit({ followUpDays: e.target.checked ? 3 : null })} />
          <span>Remind me if no reply in</span>
          <input
            className="followup-days num"
            type="number"
            min={1}
            max={365}
            value={s.followUpDays ?? 3}
            disabled={s.followUpDays === null}
            aria-label="Days to wait for a reply"
            onChange={(e) => edit({ followUpDays: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })}
          />
          <span>days</span>
        </label>
        <span className="grow" />
        <span className="save-state muted" role="status">
          {s.save === "saving" ? "Saving…" : s.save === "saved" ? "Draft saved" : s.save === "error" ? "Couldn't save" : ""}
        </span>
        <button type="button" className="icon-btn" aria-label="Discard draft" title="Discard (Shift+⌘,)" onClick={() => void discardDraft()}>
          <Icon name="trash" />
        </button>
      </footer>

      {pickerOpen && (
        <SnippetPicker
          onClose={() => {
            setPickerOpen(false);
            editor.current?.restoreSelection();
          }}
          onPick={(sn) => {
            setPickerOpen(false);
            editor.current?.restoreSelection();
            insertSnippet(sn);
          }}
          list={snippets}
        />
      )}
      {s.sending && <div className="composer-busy" aria-hidden="true" />}
    </section>
  );
}

function SendButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sending = useCompose((s) => s.sending);
  const hasThread = useCompose((s) => Boolean(s.threadId));
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div className="send" ref={ref}>
      <button type="button" className="btn btn-primary send-main" onClick={() => void sendCompose()} disabled={sending} title="Send (⌘Enter)">
        Send
        <Keys binding="mod+enter" />
      </button>
      <button type="button" className="btn btn-primary send-more" aria-haspopup="menu" aria-expanded={open} aria-label="More send options" onClick={() => setOpen((o) => !o)}>
        <Icon name="chevron-down" size={14} />
      </button>
      {open && (
        <div className="menu menu-up" role="menu">
          <button className="menu-item" role="menuitem" onClick={() => (setOpen(false), sendLater())}>
            <span className="grow">Send later…</span>
            <Keys binding="mod+shift+l" />
          </button>
          {hasThread && (
            <button className="menu-item" role="menuitem" onClick={() => (setOpen(false), void sendCompose({ markDone: true }))}>
              <span className="grow">Send and mark done</span>
              <Keys binding="mod+shift+enter" />
            </button>
          )}
          <button className="menu-item" role="menuitem" onClick={() => (setOpen(false), void sendCompose({ instant: true }))}>
            <span className="grow">Send instantly</span>
            <Keys binding="mod+shift+z" />
          </button>
        </div>
      )}
    </div>
  );
}

function LinkBar({ editor, onClose }: { editor: React.RefObject<EditorApi | null>; onClose: () => void }) {
  const [url, setUrl] = useState("https://");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
    editor.current?.restoreSelection();
    const sel = window.getSelection();
    if (sel && sel.isCollapsed) document.execCommand("insertHTML", false, `<a href="${href.replace(/"/g, "%22")}">${href.replace(/</g, "&lt;")}</a>`);
    else document.execCommand("createLink", false, href);
    onClose();
  };
  return (
    <form className="link-bar" onSubmit={apply}>
      <Icon name="link" />
      <input
        ref={input}
        className="field"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-label="Link address"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            editor.current?.restoreSelection();
          }
        }}
      />
      <button type="submit" className="btn btn-sm btn-primary">
        Add link
      </button>
      <button type="button" className="btn btn-sm btn-quiet" onClick={onClose}>
        Cancel
      </button>
    </form>
  );
}

function SnippetPicker({ list, onPick, onClose }: { list: import("../types.ts").Snippet[]; onPick: (s: import("../types.ts").Snippet) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const items = fuzzyFilter(list, q, (s) => s.name);
  return (
    <Dialog label="Snippets" onClose={onClose} className="dialog-narrow" placement="top" initialFocus="input">
      <div className="picker">
        <input
          className="picker-input"
          placeholder="Find a snippet"
          value={q}
          onChange={(e) => (setQ(e.target.value), setActive(0))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (items.length ? (a + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length : 0));
            } else if (e.key === "Enter" && items[active]) {
              e.preventDefault();
              onPick(items[active]!);
            }
          }}
          aria-label="Find a snippet"
        />
        <ul className="picker-list" role="listbox">
          {items.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === active} className={i === active ? "active" : ""} onMouseEnter={() => setActive(i)} onClick={() => onPick(s)}>
              <span className="picker-title">{s.name}</span>
              <span className="picker-sub ellipsis">{htmlToText(s.bodyHtml).slice(0, 80)}</span>
            </li>
          ))}
          {items.length === 0 && <li className="picker-empty">{list.length === 0 ? "No snippets yet. Add some in Settings." : "No snippets match."}</li>}
        </ul>
      </div>
    </Dialog>
  );
}
