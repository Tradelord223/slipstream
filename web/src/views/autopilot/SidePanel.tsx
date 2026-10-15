import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { LabelChip } from "../../components/labels/LabelChip.tsx";
import { addSenderRule, createSenderRule, learnVoice, patchAutopilot, refreshAutopilot, removeSenderRule, saveSettings } from "../../store/autopilot.ts";
import { toast } from "../../store/toasts.ts";
import type { AutopilotMetrics, AutopilotOverview, SenderRule, SenderSuggestion } from "../../types.ts";
import { Switch } from "./Switch.tsx";

export function SidePanel({ overview }: { overview: AutopilotOverview }) {
  return (
    <>
      {overview.suggestions.length > 0 && <Suggestions list={overview.suggestions} />}
      <Playbook overview={overview} />
      <Drafting overview={overview} />
      <SenderRules rules={overview.senderRules} labels={overview.labels} />
      <Metrics m={overview.metrics} />
    </>
  );
}

/** A text box that follows the server until the person starts typing. */
function useDraftText(saved: string) {
  const [text, setText] = useState(saved);
  const last = useRef(saved);
  useEffect(() => {
    // Take what the server has, unless there are unsaved edits.
    setText((cur) => (cur === last.current ? saved : cur));
    last.current = saved;
  }, [saved]);
  return [text, setText, text !== saved] as const;
}

// ---- Suggestions ----------------------------------------------------------------------------------

function suggestionText(s: SenderSuggestion): string {
  const n = s.times === 2 ? "twice" : `${s.times} times`;
  const label = s.action.labels[0];
  if (s.action.action === "done") return `You cleared mail from ${s.pattern} ${n}. Always mark it done?`;
  if (label) return `You added “${label}” to mail from ${s.pattern} ${n}. Always label it and keep it?`;
  return `You moved mail from ${s.pattern} back to the inbox ${n}. Always keep it?`;
}

function Suggestions({ list }: { list: SenderSuggestion[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <section className="panel-block ap-card ap-suggest" aria-label="Suggested rules">
      <h3 className="block-title">Suggested rules</h3>
      <ul className="ap-suggest-list" role="list">
        {list.map((s) => (
          <li key={`${s.pattern}|${s.action.action}|${s.action.labels.join()}`}>
            <p>{suggestionText(s)}</p>
            <button
              className="btn btn-sm btn-primary"
              disabled={busy !== null}
              onClick={() => {
                setBusy(s.pattern);
                void addSenderRule(s.pattern, s.action).finally(() => setBusy(null));
              }}
            >
              Create rule
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- Your rules ---------------------------------------------------------------------------------------

function Playbook({ overview }: { overview: AutopilotOverview }) {
  const id = useId();
  const [text, setText, dirty] = useDraftText(overview.settings.playbook);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveSettings({ playbook: text.trim() });
      toast.info("Rules saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your rules");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel-block ap-card" aria-labelledby={`${id}-t`}>
      <h3 className="block-title" id={`${id}-t`}>
        Your rules
      </h3>
      <label className="form-row" htmlFor={id}>
        <span className="sr-only">Your rules, in plain words</span>
        <textarea
          id={id}
          className="field"
          rows={5}
          maxLength={4000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Anything from my team stays in the inbox.\nReceipts go to “Receipts” and are marked done."}
          aria-describedby={`${id}-h`}
        />
        <span className="form-hint" id={`${id}-h`}>
          Write them the way you'd tell an assistant. Labels you put in quotes may be created if they don't exist yet.
        </span>
      </label>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-actions start">
        <button className="btn btn-sm btn-primary" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? "Saving…" : "Save rules"}
        </button>
      </div>
    </section>
  );
}

// ---- Draft replies and how you write ------------------------------------------------------------------------

function Drafting({ overview }: { overview: AutopilotOverview }) {
  const id = useId();
  const { draftReplies, voice } = overview.settings;
  const [text, setText, dirty] = useDraftText(voice);
  const [busy, setBusy] = useState(false);
  const [learning, setLearning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveSettings({ voice: text.trim() });
      toast.info("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setBusy(false);
    }
  };

  const learn = async () => {
    setLearning(true);
    setError(null);
    try {
      const run = await learnVoice();
      // It runs like any other agent run; wait for it to finish, then read what it saved.
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const r = await api.cloudRun(run.id);
        if (r.status === "running" || r.status === "starting") continue;
        if (r.status !== "done") setError(r.error ?? "Couldn't learn from your sent mail.");
        else toast.info("Learned how you write");
        break;
      }
      refreshAutopilot(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't learn from your sent mail.");
    } finally {
      setLearning(false);
    }
  };

  return (
    <section className="panel-block ap-card" aria-labelledby={`${id}-t`}>
      <h3 className="block-title" id={`${id}-t`}>
        Draft replies
      </h3>
      <Switch
        checked={draftReplies}
        label="Write a reply for mail that needs one"
        hint="Drafts wait in the conversation. You read them and send them."
        onChange={(v) => void patchAutopilot({ draftReplies: v })}
      />
      <div className="ap-voice">
        <label className="form-row" htmlFor={id}>
          <span>How you write</span>
          <textarea
            id={id}
            className="field"
            rows={5}
            maxLength={3000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Not learned yet. Replies are short and plain until Autopilot reads some of your sent mail."
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="form-actions start ap-voice-actions">
          <button className="btn btn-sm" disabled={learning} onClick={() => void learn()}>
            {learning ? "Reading your sent mail…" : "Learn from my sent mail"}
          </button>
          <button className="btn btn-sm btn-primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </section>
  );
}

// ---- Sender rules ------------------------------------------------------------------------------------------

function SenderRules({ rules, labels }: { rules: SenderRule[]; labels: string[] }) {
  const id = useId();
  const [pattern, setPattern] = useState("");
  const [action, setAction] = useState<"keep" | "done">("keep");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = pattern.trim().toLowerCase();
    if (!p) return setError("Enter an address like ana@example.com, or a domain like @example.com.");
    setBusy(true);
    setError(null);
    try {
      await createSenderRule(p, { action, labels: label.trim() ? [label.trim()] : [], priority: "normal" });
      setPattern("");
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that rule");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel-block ap-card" aria-labelledby={`${id}-t`}>
      <div>
        <h3 className="block-title" id={`${id}-t`}>
          Sender rules
        </h3>
        <p className="block-lead ap-lead">These run first, before any model looks at the mail.</p>
      </div>
      {rules.length > 0 ? (
        <ul className="ap-rules" role="list">
          {rules.map((r) => (
            <li key={r.id}>
              <div className="ap-rule">
                <span className="ap-rule-pattern">{r.pattern}</span>
                <span className="ap-rule-does">
                  {r.action.action === "keep" ? "Keep in inbox" : "Mark done"}
                  {r.action.labels.map((l) => (
                    <LabelChip key={l} name={l} />
                  ))}
                </span>
              </div>
              <button className="icon-btn ap-icon" aria-label={`Remove the rule for ${r.pattern}`} onClick={() => void removeSenderRule(r.id)}>
                <Icon name="trash" size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ap-none">No rules yet.</p>
      )}
      <form className="ap-rule-form" onSubmit={add} noValidate>
        <label className="form-row" htmlFor={`${id}-p`}>
          <span>Sender</span>
          <input id={`${id}-p`} className="field" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="orders@shop.example or @shop.example" autoComplete="off" spellCheck={false} />
        </label>
        <div className="ap-rule-row">
          <label className="form-row" htmlFor={`${id}-a`}>
            <span>Then</span>
            <select id={`${id}-a`} className="select" value={action} onChange={(e) => setAction(e.target.value as "keep" | "done")}>
              <option value="keep">Keep in inbox</option>
              <option value="done">Mark done</option>
            </select>
          </label>
          <label className="form-row" htmlFor={`${id}-l`}>
            <span>Label (optional)</span>
            <input id={`${id}-l`} className="field" value={label} onChange={(e) => setLabel(e.target.value)} list={`${id}-labels`} autoComplete="off" maxLength={60} />
            <datalist id={`${id}-labels`}>
              {labels.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </label>
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="form-actions start">
          <button className="btn btn-sm" disabled={busy}>
            Add rule
          </button>
        </div>
      </form>
    </section>
  );
}

// ---- Numbers ----------------------------------------------------------------------------------------------

function Metrics({ m }: { m: AutopilotMetrics }) {
  const id = useId();
  return (
    <section className="panel-block ap-card" aria-labelledby={`${id}-t`}>
      <h3 className="block-title" id={`${id}-t`}>
        Last 30 days
      </h3>
      {m.decided === 0 ? (
        <p className="ap-none">Nothing yet. Numbers show up once Autopilot has sorted some mail.</p>
      ) : (
        <>
          <p className="ap-stats">
            Sorted <b className="num">{m.decided}</b> · You changed <b className="num">{m.corrected}</b> · <b className="num">{m.draftsWritten}</b> {m.draftsWritten === 1 ? "draft" : "drafts"},{" "}
            <b className="num">{m.draftsSentAsWritten}</b> sent as written
          </p>
          <p className="ap-none">
            {m.outOfInbox} cleared from your inbox{m.bySenderRules > 0 ? `. Your sender rules handled ${m.bySenderRules} more` : ""}
            {m.averageEdit !== null && m.draftsSent > 0 ? `. Drafts you sent were changed by about ${Math.round(m.averageEdit * 100)}% on average` : ""}.
          </p>
        </>
      )}
    </section>
  );
}
