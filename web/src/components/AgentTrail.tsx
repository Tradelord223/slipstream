import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { agoShort } from "../lib/format.ts";
import { useNow } from "../lib/hooks.ts";
import { activityTick, undoActivity } from "../store/agents.ts";
import { openDraft } from "../store/compose.ts";
import { useStore } from "../store/createStore.ts";
import { navigate } from "../store/route.ts";
import type { ActivityItem } from "../types.ts";
import { AgentGlyph } from "./AgentGlyph.tsx";

const SHOWN = 3;

/** What the agent did, phrased from the conversation's point of view. */
const DID: Record<string, string> = {
  "triage.done": "marked this done",
  "triage.inbox": "moved this back to the inbox",
  "triage.remind": "set a reminder on this",
  "triage.cancelReminder": "cancelled the reminder on this",
  "triage.star": "starred this",
  "triage.unstar": "removed the star from this",
  "triage.markRead": "marked this read",
  "triage.markUnread": "marked this unread",
  "triage.mute": "muted this",
  "triage.unmute": "unmuted this",
  "triage.label": "labelled this",
  "triage.unlabel": "removed a label from this",
  "triage.trash": "moved this to the trash",
  "triage.untrash": "restored this from the trash",
  "triage.spam": "reported this as spam",
  "triage.notSpam": "moved this out of spam",
  "mail.unsubscribe": "unsubscribed from this sender",
  "drafts.create": "drafted a reply",
  "drafts.update": "edited the draft",
  "drafts.delete": "discarded a draft",
  "drafts.send": "sent a reply",
  "drafts.cancelSend": "cancelled a send",
  "team.share": "shared this with the team",
  "team.comment": "commented for the team",
};

const WAITING: Record<string, string> = {
  "drafts.send": "is waiting for your OK to send a reply",
  "triage.trash": "is waiting for your OK to trash this",
  "triage.spam": "is waiting for your OK to report this as spam",
  "mail.unsubscribe": "is waiting for your OK to unsubscribe",
};

/** Agent actions on one conversation, newest first: at most three lines, the rest behind "Show all". */
export function AgentTrail({ threadId, draftId }: { threadId: string; draftId: string | null }) {
  const tick = useStore(activityTick, (s) => s.n);
  const now = useNow();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [all, setAll] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    api
      .activity({ threadId, limit: 20 }, ctl.signal)
      .then((r) => setItems(r.activity.filter((a) => a.actor.kind === "agent" && a.command !== "undo" && (a.status === "done" || a.status === "pending"))))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [threadId, tick]);

  useEffect(() => setAll(false), [threadId]);

  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, SHOWN);
  const hidden = items.length - shown.length;
  return (
    <ul className="trail" role="list" aria-label="What assistants did here">
      {shown.map((a, index) => {
        const pending = a.status === "pending";
        const text = pending ? (WAITING[a.command] ?? "is waiting for your OK") : (DID[a.command] ?? a.summary.charAt(0).toLowerCase() + a.summary.slice(1));
        return (
          <li key={a.id} className="trail-line">
            <AgentGlyph name={a.actor.name} size={18} />
            <span className="trail-text">
              <strong>{a.actor.name}</strong> {text}
            </span>
            <span className="trail-sep" aria-hidden="true">
              ·
            </span>
            <time className="trail-time num" dateTime={new Date(a.createdAt).toISOString()}>
              {agoShort(a.createdAt, now)}
            </time>
            {pending && <TrailAction onClick={() => navigate("/review")}>Review</TrailAction>}
            {a.canUndo && !pending && (
              <TrailAction onClick={() => void undoActivity(a.id)} label={`Undo: ${a.summary}`}>
                Undo
              </TrailAction>
            )}
            {a.command === "drafts.create" && a.status === "done" && draftId && items.findIndex((x) => x.command === "drafts.create") === index && (
              <TrailAction onClick={() => void openDraft(draftId)}>Open draft</TrailAction>
            )}
          </li>
        );
      })}
      {(hidden > 0 || (all && items.length > SHOWN)) && (
        <li className="trail-more">
          <button className="trail-act trail-act-solo" onClick={() => setAll((v) => !v)} aria-expanded={all}>
            {all ? "Show fewer" : `Show all ${items.length}`}
          </button>
        </li>
      )}
    </ul>
  );
}

function TrailAction({ onClick, label, children }: { onClick: () => void; label?: string; children: string }) {
  return (
    <>
      <span className="trail-sep" aria-hidden="true">
        ·
      </span>
      <button className="trail-act" onClick={onClick} aria-label={label}>
        {children}
      </button>
    </>
  );
}
