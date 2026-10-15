import { useState } from "react";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { RichBox } from "../../components/RichBox.tsx";
import { htmlToText } from "../../lib/format.ts";
import { loadSnippets, useSession } from "../../store/session.ts";
import { toast } from "../../store/toasts.ts";
import type { Snippet } from "../../types.ts";

export function SnippetsSettings() {
  const snippets = useSession((s) => s.snippets);
  const [editing, setEditing] = useState<Snippet | "new" | null>(null);

  const remove = async (s: Snippet) => {
    try {
      await api.deleteSnippet(s.id);
      await loadSnippets();
      toast.info(`Removed ${s.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that snippet");
    }
  };

  return (
    <div className="settings-list">
      <section className="panel-block">
        <p className="block-lead">
          Type <kbd className="keycap">;</kbd> in a message to drop one in. {"{first_name}"}, {"{last_name}"} and {"{full_name}"} fill from the first person you’re writing to.
        </p>
        {editing ? (
          <SnippetForm key={editing === "new" ? "new" : editing.id} initial={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />
        ) : (
          <button className="btn" onClick={() => setEditing("new")}>
            <Icon name="plus" /> New snippet
          </button>
        )}
      </section>
      <section className="panel-block" aria-label="Your snippets">
        <ul className="snippet-list" role="list">
          {snippets.map((s) => (
            <li key={s.id} className="snippet-row">
              <span className="snippet-main">
                <span className="snippet-title">
                  {s.name} {s.shared && <span className="chip">Shared</span>}
                </span>
                <span className="snippet-body ellipsis">{htmlToText(s.bodyHtml)}</span>
              </span>
              <span className="snippet-uses num muted">{s.useCount > 0 ? `Used ${s.useCount}×` : ""}</span>
              {s.mine ? (
                <>
                  <button className="btn btn-sm" onClick={() => setEditing(s)}>
                    Edit
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => void remove(s)}>
                    Remove
                  </button>
                </>
              ) : (
                <span className="muted">From {s.author}</span>
              )}
            </li>
          ))}
          {snippets.length === 0 && <li className="muted account-empty">No snippets yet.</li>}
        </ul>
      </section>
    </div>
  );
}

function SnippetForm({ initial, onDone }: { initial?: Snippet; onDone: () => void }) {
  const workspace = useSession((s) => s.workspace);
  const [name, setName] = useState(initial?.name ?? "");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.bodyHtml ?? "");
  const [shared, setShared] = useState(initial?.shared ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = { name: name.trim(), subject: subject.trim() || null, bodyHtml: body, shared };
      if (initial) await api.updateSnippet(initial.id, payload);
      else await api.createSnippet(payload);
      await loadSnippets();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that snippet");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="snippet-form" onSubmit={save}>
      <label className="form-row">
        <span>Name</span>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Intro call" required autoFocus />
      </label>
      <label className="form-row">
        <span>Subject (optional)</span>
        <input className="field" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <div className="form-row">
        <span>Message</span>
        <RichBox label="Snippet message" html={body} onCommit={setBody} />
      </div>
      {workspace && (
        <label className="switch">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          <span>Share with {workspace.name}</span>
        </label>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-actions start">
        <button className="btn btn-primary" disabled={busy || !name.trim()}>
          {initial ? "Save snippet" : "Add snippet"}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
