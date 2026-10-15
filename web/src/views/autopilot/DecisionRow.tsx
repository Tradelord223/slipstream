import { useState } from "react";
import { Icon } from "../../components/Icon.tsx";
import { Keys } from "../../components/Keycap.tsx";
import { LabelChip } from "../../components/labels/LabelChip.tsx";
import { agoShort, displayName, longTime } from "../../lib/format.ts";
import { acceptItem, autopilot, dismissItem, isProposal, openItem, undoItem } from "../../store/autopilot.ts";
import type { AutopilotItem } from "../../types.ts";

const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** "Back Thu 9:00 AM" within the week, "Back Oct 21" beyond it. */
function backWhen(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "Back later";
  return `Back ${t - now < 7 * 86_400_000 ? dayFmt.format(t) : dateFmt.format(t)}`;
}

type Tag = { text: string; tone?: "good" | "warn" | "bad" | "mine" };

/** Where this decision stands, in the words a person would use. */
function stateTag(i: AutopilotItem): Tag {
  if (i.stage === "failed") return { text: "Couldn't sort", tone: "bad" };
  if (i.stage !== "decided") return { text: "Sorting" };
  if (i.status === "corrected") return { text: "Corrected", tone: "warn" };
  if (i.status === "dismissed") return { text: "Dismissed" };
  if (i.source === "sender") return { text: "Your rule", tone: "mine" };
  if (i.applied) return { text: "Applied", tone: "good" };
  return { text: "Waiting for you", tone: "warn" };
}

export function DecisionRow({ item, focused, now, register }: { item: AutopilotItem; focused: boolean; now: number; register: (el: HTMLLIElement | null) => void }) {
  const [busy, setBusy] = useState(false);
  const d = item.decision;
  const tag = stateTag(item);
  const proposal = isProposal(item);
  const canUndo = item.applied && item.status !== "corrected" && item.status !== "dismissed";
  const when = item.decidedAt ?? item.createdAt;
  const titleId = `ap-${item.id}`;

  const act = async (fn: (id: string) => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn(item.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      ref={register}
      className={`ap-row ${focused ? "focused" : ""} ${item.status === "dismissed" ? "quiet" : ""}`}
      tabIndex={focused ? 0 : -1}
      aria-current={focused ? "true" : undefined}
      aria-labelledby={titleId}
      onFocus={() => autopilot.get().focusedId !== item.id && autopilot.set({ focusedId: item.id })}
      onMouseDown={() => autopilot.get().focusedId !== item.id && autopilot.set({ focusedId: item.id })}
    >
      <div className="ap-main">
        <div className="ap-line" id={titleId}>
          <span className="ap-from">{displayName(item.from)}</span>
          <span className="ap-subject">{item.subject}</span>
        </div>
        <div className="ap-chips">
          {d && (
            <span className={`chip ap-act ap-act-${d.action}`}>
              {d.action === "keep" ? "Kept" : d.action === "done" ? "Done" : backWhen(d.remindAt, now)}
            </span>
          )}
          {d?.priority === "urgent" && (
            <span className="chip ap-urgent">
              <Icon name="alert" size={12} /> Urgent
            </span>
          )}
          {d?.labels.map((l) => <LabelChip key={l} name={l} />)}
          {item.draftId && (
            <button className="chip ap-draft" onClick={() => openItem(item)} aria-label={`Draft ready for ${item.subject}. Open the conversation`}>
              <Icon name="file" size={12} /> Draft ready
            </button>
          )}
          {item.draftSent && (
            <span className="chip ap-act">
              <Icon name="send" size={12} /> Reply sent
            </span>
          )}
          <span className={`ap-tag ${tag.tone ? `ap-tag-${tag.tone}` : ""}`}>{tag.text}</span>
        </div>
        {d?.reason && <p className="ap-reason">{d.reason}</p>}
        {d?.warnings?.map((w) => (
          <p className="ap-warn" key={w}>
            <Icon name="alert" size={13} />
            <span>{w}</span>
          </p>
        ))}
      </div>
      <div className="ap-side-col">
        <div className="ap-meta">
          {d && item.source === "model" && (
            <span className="ap-conf num" title="How sure Autopilot was">
              {Math.round(d.confidence * 100)}% sure
            </span>
          )}
          <time className="num" dateTime={new Date(when).toISOString()} title={longTime(when)}>
            {agoShort(when, now)}
          </time>
        </div>
        <div className="ap-actions">
          {proposal && (
            <>
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(acceptItem)} aria-label={`Accept: ${item.subject}`}>
                Accept
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => void act(dismissItem)} aria-label={`Dismiss: ${item.subject}`}>
                Dismiss
              </button>
            </>
          )}
          {canUndo && (
            <button className="btn btn-sm" disabled={busy} onClick={() => void act(undoItem)} aria-label={`Undo: ${item.subject}`}>
              <Icon name="undo" size={14} /> Undo
            </button>
          )}
          <button className="btn btn-sm btn-quiet" onClick={() => openItem(item)} aria-label={`Open: ${item.subject}`}>
            Open {focused && <Keys binding="enter" />}
          </button>
        </div>
      </div>
    </li>
  );
}
