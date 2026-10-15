import { useMemo, useState } from "react";
import { blocks, parseTool, splitContext, turns, type Turn } from "../../lib/cloudText.ts";
import { parsePreview } from "../../views/ReviewView.tsx";
import { decide } from "../../store/agents.ts";
import { navigate } from "../../store/route.ts";
import type { Approval, CloudRun } from "../../types.ts";
import { Icon } from "../Icon.tsx";

/** What Claude said, as readable turns: your words in a block, its words as plain text, its actions as quiet lines. */
export function Transcript({ run, approvals }: { run: CloudRun; approvals: Approval[] }) {
  const list = useMemo(() => turns(run), [run]);
  const active = run.status === "running" || run.status === "starting";
  return (
    <div className="tr">
      {list.map((t, i) => (
        <TurnView key={i} turn={t} live={active && i === list.length - 1} />
      ))}
      {approvals.map((a) => (
        <InlineApproval key={a.id} a={a} />
      ))}
      {active && (
        <div className="tr-working" role="status">
          <span className="spinner" aria-hidden="true" />
          {run.status === "starting" ? "Starting…" : "Working…"}
        </div>
      )}
    </div>
  );
}

function TurnView({ turn, live }: { turn: Turn; live: boolean }) {
  switch (turn.kind) {
    case "user": {
      const { text, context } = splitContext(turn.text);
      return (
        <div className="tr-you">
          <p>{text}</p>
          {context.length > 0 && (
            <ul className="tr-ctx" role="list" aria-label="Context sent with this message">
              {context.map((c, i) => (
                <li key={i} className="as-chip">
                  <Icon name="mail" size={13} />
                  <span className="ellipsis">{c.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case "note":
      return (
        <p className={`tr-note ${/^Paused after /.test(turn.text) ? "calm" : ""}`} role="note">
          {turn.text}
        </p>
      );
    case "agent":
      return (
        <div className="tr-says">
          {blocks(turn.text).map((b, i) =>
            b.kind === "p" ? (
              <p key={i}>{b.text}</p>
            ) : (
              <ul key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ul>
            ),
          )}
        </div>
      );
    case "tools":
      return <ToolGroup entries={turn.entries} live={live} />;
  }
}

/** One muted line per action; a click shows the command behind it. Long runs fold into a single line. */
function ToolGroup({ entries, live }: { entries: { text: string }[]; live: boolean }) {
  const long = entries.length > 4 && !live;
  const [open, setOpen] = useState(false);
  if (long && !open) {
    return (
      <button className="tr-fold" aria-expanded={false} onClick={() => setOpen(true)}>
        <Icon name="chevron-right" size={12} />
        {entries.length} steps
      </button>
    );
  }
  return (
    <ul className="tr-tools" role="list" aria-label="What the assistant did">
      {entries.map((e, i) => (
        <ToolLine key={i} text={e.text} />
      ))}
      {long && (
        <li>
          <button className="tr-fold" aria-expanded onClick={() => setOpen(false)}>
            <Icon name="chevron-down" size={12} />
            Hide steps
          </button>
        </li>
      )}
    </ul>
  );
}

function ToolLine({ text }: { text: string }) {
  const { name, failed, phrase } = parseTool(text);
  const [open, setOpen] = useState(false);
  return (
    <li className={failed ? "failed" : ""}>
      <button className="tr-tool" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        <span>{failed ? `${phrase} (didn't work)` : phrase}</span>
      </button>
      {open && <span className="tr-cmd">{name}</span>}
    </li>
  );
}

/** A request this run made that is waiting for you, answerable without leaving the conversation. */
function InlineApproval({ a }: { a: Approval }) {
  const { fields, body } = useMemo(() => parsePreview(a.preview), [a.preview]);
  return (
    <section className="tr-ask" aria-label={a.title}>
      <div className="tr-ask-title">{a.title}</div>
      {fields.length > 0 && (
        <dl className="tr-ask-fields">
          {fields
            .filter((f) => f.label !== "Send at")
            .map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value || "None"}</dd>
              </div>
            ))}
        </dl>
      )}
      {body && <p className="tr-ask-body">{body}</p>}
      <div className="tr-ask-actions">
        <button className="btn btn-sm btn-primary" onClick={() => void decide(a, "approve")}>
          <Icon name="check" /> Approve
        </button>
        <button className="btn btn-sm" onClick={() => void decide(a, "reject")}>
          <Icon name="x" /> Reject
        </button>
        <button className="btn btn-sm btn-quiet" onClick={() => navigate("/review")}>
          Open in Review
        </button>
      </div>
    </section>
  );
}
