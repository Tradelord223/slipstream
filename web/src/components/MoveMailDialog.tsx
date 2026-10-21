import { useEffect, useMemo, useState } from "react";
import { CATEGORIES, categoryName, isPersonalDomain } from "../lib/sorting.ts";
import { closeSortingDialog, moveMail, scopeLabel, type Scope } from "../store/sorting.ts";
import { useThread } from "../store/threads.ts";
import type { Category, Sorting } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";
import { Keys } from "./Keycap.tsx";

interface ScopeChoice {
  scope: Scope;
  title: string;
  detail: string;
}

/** What a correction can name for this conversation: its latest sender, that sender's company, the mailing list it came through. */
function scopesOf(s: Sorting): ScopeChoice[] {
  const out: ScopeChoice[] = [];
  if (s.sender) out.push({ scope: "sender", title: s.sender.name || s.sender.email, detail: s.sender.name ? s.sender.email : "This sender" });
  if (s.domain && !isPersonalDomain(s.domain)) out.push({ scope: "domain", title: s.domain, detail: "Everyone at this company" });
  if (s.listId) out.push({ scope: "list", title: "This mailing list", detail: s.listId });
  return out;
}

/** "Humble Bundle", "everyone at shop.com", "the list news.shop.com": what a stored pattern means in words. */
export function patternWords(pattern: string): string {
  if (pattern.startsWith("list:")) return `the list ${pattern.slice(5)}`;
  if (pattern.startsWith("@")) return `everyone at ${pattern.slice(1)}`;
  return pattern;
}

/** "Move mail from <sender> to: Important / Updates / ...", with sender, company or mailing list to choose from. */
export function MoveMailDialog({ threadId }: { threadId: string }) {
  const { detail, error, loading, retry } = useThread(threadId);
  const sorting = detail?.sorting ?? null;
  const scopes = useMemo(() => (sorting ? scopesOf(sorting) : []), [sorting]);
  const [scope, setScope] = useState<Scope>("sender");
  const [busy, setBusy] = useState<Category | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // The sender is the default; a conversation with no incoming sender starts on whatever it can name.
  useEffect(() => {
    if (scopes.length > 0 && !scopes.some((c) => c.scope === scope)) setScope(scopes[0]!.scope);
  }, [scopes, scope]);

  // Focus lands on the first tab once the choices are on screen, even if the conversation was still loading.
  const ready = scopes.length > 0;
  useEffect(() => {
    if (ready) document.querySelector<HTMLElement>(".move-dialog [data-first]")?.focus();
  }, [ready]);

  const pick = async (category: Category) => {
    if (!sorting || busy) return;
    setBusy(category);
    setProblem(null);
    try {
      await moveMail(threadId, scope, category, sorting);
      closeSortingDialog();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Couldn't move that mail");
      setBusy(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= CATEGORIES.length) {
      e.preventDefault();
      void pick(CATEGORIES[n - 1]!.id);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (scopes.length < 2) return;
      e.preventDefault();
      const i = scopes.findIndex((c) => c.scope === scope);
      setScope(scopes[(i + (e.key === "ArrowRight" ? 1 : -1) + scopes.length) % scopes.length]!.scope);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-cat]")];
      const at = rows.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      rows[(at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
    }
  };

  const who = sorting ? scopeLabel(scope, sorting) : "";
  return (
    <Dialog label="Move mail to another tab" onClose={closeSortingDialog} className="dialog-narrow move-dialog" initialFocus="[data-first]" trapKeys>
      <div onKeyDown={onKeyDown}>
        <div className="dialog-head">
          <h3 aria-hidden="true">Move mail to another tab</h3>
          <button className="icon-btn" aria-label="Close" onClick={closeSortingDialog}>
            <Icon name="x" />
          </button>
        </div>

        {error ? (
          <div className="move-state" role="alert">
            <p>Couldn't open this conversation.</p>
            <div className="form-actions">
              <button className="btn" onClick={retry}>
                Try again
              </button>
            </div>
          </div>
        ) : loading || !sorting ? (
          <div className="move-state" aria-busy="true">
            <span className="skeleton-line" style={{ width: "58%" }} />
            <span className="skeleton-line" style={{ width: "90%" }} />
            <span className="skeleton-line" style={{ width: "74%" }} />
          </div>
        ) : scopes.length === 0 ? (
          <p className="move-state">This conversation has no incoming mail to move.</p>
        ) : (
          <>
            {scopes.length > 1 ? (
              <div className="move-group">
                <div className="move-label" id="move-from">
                  From
                </div>
                <div className="move-scopes" role="radiogroup" aria-labelledby="move-from">
                  {scopes.map((c) => (
                    <button key={c.scope} type="button" role="radio" aria-checked={c.scope === scope} className="move-scope" onClick={() => setScope(c.scope)}>
                      <span className="radio-dot" aria-hidden="true" />
                      <span className="move-scope-text">
                        <span className="ellipsis">{c.title}</span>
                        <span className="move-scope-detail ellipsis">{c.detail}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="move-from">
                Mail from <strong>{who}</strong>
              </p>
            )}

            <div className="move-group">
              <div className="move-label" id="move-to">
                Move to
              </div>
              <div className="move-cats" role="group" aria-labelledby="move-to">
                {CATEGORIES.map((c, i) => {
                  const here = sorting.category === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className="move-cat"
                      data-cat={c.id}
                      data-first={i === 0 ? "" : undefined}
                      disabled={busy !== null}
                      aria-busy={busy === c.id || undefined}
                      onClick={() => void pick(c.id)}
                    >
                      <span className="grow">{c.name}</span>
                      {here && <span className="chip">Here now</span>}
                      <Keys binding={String(i + 1)} />
                    </button>
                  );
                })}
              </div>
            </div>

            {sorting.rule && (
              <p className="move-note">
                You moved {patternWords(sorting.rule.pattern)} to {categoryName(sorting.rule.category)}.
              </p>
            )}
            {problem && (
              <div className="form-error" role="alert">
                {problem}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
